import { describe, expect, it } from "vitest";
import { DEFAULT_BACKUP_RETENTION } from "@paperclipai/shared";
import { instanceSettingsService } from "../services/instance-settings.js";

/**
 * KEWL-4636: config.json's database.backup.retentionDays had zero effect on
 * the live scheduled backup because the server reads retention from
 * Instance Settings (DB), not config.json. This proves the bootstrap-seed
 * fix actually seeds a brand-new row from config, clamped to the nearest
 * supported preset — and, just as important, proves an EXISTING row is
 * left untouched (the DB stays authoritative once a row exists, by design).
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

describe("KEWL-4636 backup retention bootstrap", () => {
  it("seeds dailyDays from config, clamped to the nearest preset, on first row creation", async () => {
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
