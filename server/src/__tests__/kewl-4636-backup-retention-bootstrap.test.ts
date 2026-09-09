import { describe, expect, it } from "vitest";
import { DEFAULT_BACKUP_RETENTION } from "@paperclipai/shared";
import { instanceSettingsService } from "../services/instance-settings.js";

/**
 * KEWL-4636: config.json's database.backup.retentionDays had zero effect on
 * the live scheduled backup because the server reads retention from
 * Instance Settings (DB), not config.json. This proves the bootstrap-seed
 * fix actually seeds a brand-new row from config, ceiling-clamped to a
 * supported preset without ever shortening the requested period — and,
 * just as important, proves an EXISTING row is left untouched (the DB
 * stays authoritative once a row exists, by design).
 *
 * Two P1s were found in exact-head review of the first version of this fix
 * (PR jonguttman/paperclip#6, commit 04d16fba51) and are covered here:
 *   1. Initialization race — some OTHER, unconfigured
 *      `instanceSettingsService(db)` reader could create the settings row
 *      before the configured one ever ran, permanently locking out the
 *      config seed. Fixed by eagerly awaiting the configured service right
 *      after construction in server/src/index.ts, before any other reader
 *      in the boot sequence touches instance settings. The
 *      "competing reader" tests below prove the ordering invariant that
 *      fix depends on: whichever caller's getOrCreateRow() resolves first
 *      wins the row permanently.
 *   2. Destructive clamping — "nearest preset" could round DOWN (e.g. a
 *      configured value of 9 rounding to a 7-day daily tier), pruning real
 *      backups earlier than the operator asked for. Fixed by switching the
 *      bootstrap seed from `clampToNearestPreset` to `clampToPresetCeiling`,
 *      which only ever rounds up.
 */
function makeFakeDb(existingRows: unknown[]) {
  const insertedValues: Record<string, unknown>[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(existingRows),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        insertedValues.push(v);
        return {
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve([{ id: "row-1", createdAt: new Date(), updatedAt: new Date(), defaultEnvironmentId: null, ...v }]),
          }),
        };
      },
    }),
  };
  return { db: db as any, insertedValues };
}

/**
 * A fake DB with real shared, mutable state across multiple
 * `instanceSettingsService(db, ...)` instances constructed against the same
 * `db` object — unlike `makeFakeDb` above, whose `existingRows` snapshot is
 * frozen at construction time and can't reflect a write made by a
 * DIFFERENT service instance. This is what's needed to reproduce the
 * competing-reader race: two independently-constructed services (one
 * configured, one not) must observe each other's row-creation exactly like
 * two real callers sharing one Postgres table would.
 */
function makeSharedFakeDb() {
  let row: Record<string, unknown> | null = null;
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(row ? [row] : []),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({
          returning: () => {
            if (!row) {
              row = { id: "row-1", createdAt: new Date(), updatedAt: new Date(), defaultEnvironmentId: null, ...v };
            }
            return Promise.resolve([row]);
          },
        }),
      }),
    }),
  };
  return { db: db as any, getRow: () => row };
}

describe("KEWL-4636 backup retention bootstrap", () => {
  it("seeds dailyDays from config, ceiling-clamped to the smallest preset >= the value, on first row creation", async () => {
    const { db } = makeFakeDb([]);
    const svc = instanceSettingsService(db, { bootstrapBackupRetentionDailyDays: 1 });
    const settings = await svc.get();
    expect(settings.general.backupRetention.dailyDays).toBe(3);
    expect(settings.general.backupRetention.weeklyWeeks).toBe(DEFAULT_BACKUP_RETENTION.weeklyWeeks);
    expect(settings.general.backupRetention.monthlyMonths).toBe(DEFAULT_BACKUP_RETENTION.monthlyMonths);
  });

  it("seeds an exact preset value unchanged", async () => {
    const { db } = makeFakeDb([]);
    const svc = instanceSettingsService(db, { bootstrapBackupRetentionDailyDays: 14 });
    const settings = await svc.get();
    expect(settings.general.backupRetention.dailyDays).toBe(14);
  });

  it("KEWL-4636 P1: rounds UP, never down — a configured 9 must not be shortened to a 7-day tier", async () => {
    const { db } = makeFakeDb([]);
    const svc = instanceSettingsService(db, { bootstrapBackupRetentionDailyDays: 9 });
    const settings = await svc.get();
    // Nearest-by-distance would have picked 7 here (destructive: prunes 2
    // days earlier than requested). The fix must pick 14.
    expect(settings.general.backupRetention.dailyDays).toBe(14);
  });

  it("caps at the largest preset when the configured value exceeds every preset (30 -> 14)", async () => {
    const { db } = makeFakeDb([]);
    const svc = instanceSettingsService(db, { bootstrapBackupRetentionDailyDays: 30 });
    const settings = await svc.get();
    // 30 isn't representable in a closed [3,7,14] enum; 14 is the best
    // achievable (and the same value "nearest" would have picked here) —
    // the per-backup drift warning in server/src/index.ts is what makes
    // this specific gap loud instead of silent, not this clamp.
    expect(settings.general.backupRetention.dailyDays).toBe(14);
  });

  it("KEWL-4636 P1: startup ordering — an unconfigured reader that runs FIRST permanently loses the config seed", async () => {
    const { db } = makeSharedFakeDb();
    const unconfigured = instanceSettingsService(db);
    const configured = instanceSettingsService(db, { bootstrapBackupRetentionDailyDays: 1 });
    // Reproduces the pre-fix race Codex flagged: some other reader (the
    // /instance/settings/general route, or the unconfigured
    // instanceSettingsService(db) call inside
    // resolveWorktreeRunExecutionActivationState during boot) creates the
    // row before the config-seeded service ever gets to run.
    await unconfigured.getGeneral();
    const settings = await configured.get();
    expect(settings.general.backupRetention).toEqual(DEFAULT_BACKUP_RETENTION);
  });

  it("KEWL-4636 P1: startup ordering — the config-seeded service running FIRST wins the row-creation race", async () => {
    const { db } = makeSharedFakeDb();
    const configured = instanceSettingsService(db, { bootstrapBackupRetentionDailyDays: 1 });
    const unconfigured = instanceSettingsService(db);
    // This is the exact invariant server/src/index.ts's fix relies on: an
    // eager `await backupSettingsSvc.getGeneral()` runs immediately after
    // construction, before any other instanceSettingsService(db) reader in
    // the boot sequence — so the configured caller always resolves
    // getOrCreateRow() first in production, matching this ordering.
    await configured.getGeneral();
    const settings = await unconfigured.get();
    expect(settings.general.backupRetention.dailyDays).toBe(3);
  });

  it("does NOT touch an existing row, even with a different bootstrap value", async () => {
    const existingRow = {
      id: "row-1",
      createdAt: new Date(),
      updatedAt: new Date(),
      defaultEnvironmentId: null,
      general: { backupRetention: { dailyDays: 3, weeklyWeeks: 2, monthlyMonths: 1 } },
      experimental: {},
    };
    const { db, insertedValues } = makeFakeDb([existingRow]);
    const svc = instanceSettingsService(db, { bootstrapBackupRetentionDailyDays: 1 });
    const settings = await svc.get();
    expect(settings.general.backupRetention).toEqual({ dailyDays: 3, weeklyWeeks: 2, monthlyMonths: 1 });
    expect(insertedValues.length).toBe(0);
  });

  it("falls back to the hardcoded default when no bootstrap value is supplied (unchanged prior behavior)", async () => {
    const { db } = makeFakeDb([]);
    const svc = instanceSettingsService(db);
    const settings = await svc.get();
    expect(settings.general.backupRetention).toEqual(DEFAULT_BACKUP_RETENTION);
  });
});
