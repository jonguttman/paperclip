/**
 * codex-plugin-seed.ts — KEWL-3853 Option B canary
 *
 * Company-scoped, policy-scoped, versioned, READ-ONLY plugin seed.
 * Architecture Guardian approved 2026-08-23 (KEWL-3866).
 *
 * Safety rules (from AG review):
 *   - Restricted runtimeToolPolicy runs MUST NOT use this seed.
 *   - The seed is never shared across companies or policy buckets.
 *   - The seed directory is chmod'd read-only before consumers can see it.
 *   - Consumers copy FROM an immutable directory; symlinks into mutable paths are forbidden.
 *   - Only the plugin source tree is seeded; never auth, config, sessions, or MCP state.
 *
 * Path shape:
 *   <instanceRoot>/companies/<companyId>/codex-plugin-seed/unrestricted/v<SCHEMA_VERSION>/<pluginsSha>/
 *
 * Canary flag: CODEX_SHARED_PLUGIN_SEED_ENABLED=1 (default OFF)
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

/** Bump this when the seed directory layout changes incompatibly. */
const SEED_SCHEMA_VERSION = 1;

const SENTINEL_FILE = ".paperclip-plugin-seed";
const TRUTHY_RE = /^(1|true|yes|on)$/i;

export type OnLog = (stream: "stdout" | "stderr", line: string) => Promise<void> | void;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns true when the plugin-seed canary is enabled for this process.
 * The flag is intentionally NOT inherited from CODEX_HOME env overrides —
 * it is a Paperclip adapter-level flag, not a Codex CLI flag.
 */
export function isPluginSeedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY_RE.test(env.CODEX_SHARED_PLUGIN_SEED_ENABLED ?? "");
}

/**
 * Resolves the immutable seed directory for a given (companyId, pluginsSha) pair.
 * Pure path computation — does not stat or create anything.
 */
export function resolvePluginSeedDir(
  env: NodeJS.ProcessEnv,
  companyId: string,
  pluginsSha: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: env.PAPERCLIP_HOME ?? undefined,
    instanceId: env.PAPERCLIP_INSTANCE_ID ?? undefined,
    env,
  });
  return path.resolve(
    instanceRoot,
    "companies",
    companyId,
    "codex-plugin-seed",
    "unrestricted",
    `v${SEED_SCHEMA_VERSION}`,
    pluginsSha,
  );
}

/**
 * Reads the `plugins.sha` file from a Codex home's `.tmp` directory.
 * Returns null if absent or unreadable (caller must handle gracefully).
 */
export async function readPluginsSha(codexHome: string): Promise<string | null> {
  try {
    const sha = (await fs.readFile(path.join(codexHome, ".tmp", "plugins.sha"), "utf8")).trim();
    return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Atomically publishes an immutable plugin seed.
 *
 * Source: the plugins directory from a canonical Codex home (typically the
 * shared ~/.codex home). The source must already be a complete, verified tree.
 *
 * Steps:
 *   1. If seedDir already exists and passes integrity check → skip (idempotent).
 *   2. Copy source plugins to a staging temp dir.
 *   3. Write a sentinel file recording companyId, sha, schema version, and timestamp.
 *   4. Recursively chmod the tree read-only (a-w).
 *   5. Rename staging dir to seedDir (atomic on POSIX).
 *
 * Callers must ensure sourcePluginsDir matches pluginsSha before calling.
 */
export async function publishPluginSeed(opts: {
  sourcePluginsDir: string;
  seedDir: string;
  pluginsSha: string;
  companyId: string;
  env: NodeJS.ProcessEnv;
  onLog?: OnLog;
}): Promise<"published" | "already_exists" | "skipped_source_missing"> {
  const { sourcePluginsDir, seedDir, pluginsSha, companyId, onLog } = opts;

  // Idempotent: seed already published.
  if (await _seedPassesIntegrityCheck(seedDir, pluginsSha)) {
    return "already_exists";
  }

  // Source must exist.
  try {
    await fs.access(sourcePluginsDir);
  } catch {
    return "skipped_source_missing";
  }

  const stagingDir = `${seedDir}.staging-${process.pid}`;
  try {
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(stagingDir), { recursive: true });

    // Copy source tree to staging.
    await _cpR(sourcePluginsDir, stagingDir);

    // Write sentinel.
    const sentinel = {
      schemaVersion: SEED_SCHEMA_VERSION,
      companyId,
      pluginsSha,
      publishedAt: new Date().toISOString(),
      sourcePath: sourcePluginsDir,
    };
    await fs.writeFile(path.join(stagingDir, SENTINEL_FILE), JSON.stringify(sentinel, null, 2));

    // Recursively chmod read-only.
    await _chmodReadOnly(stagingDir);

    // Atomic rename.
    try {
      await fs.rename(stagingDir, seedDir);
    } catch (renameErr: unknown) {
      // Race: another process won.
      if ((renameErr as NodeJS.ErrnoException).code === "ENOTEMPTY" || (renameErr as NodeJS.ErrnoException).code === "EEXIST") {
        await fs.rm(stagingDir, { recursive: true, force: true });
        return "already_exists";
      }
      throw renameErr;
    }

    await onLog?.("stdout", `[paperclip] Published plugin seed for SHA ${pluginsSha.slice(0, 12)} at "${seedDir}".\n`);
    return "published";
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Applies an existing immutable plugin seed into a CODEX_HOME's `.tmp/plugins/`
 * directory, allowing Codex to skip a fresh plugin download.
 *
 * Safety invariants enforced here:
 *   - isRestricted must be false (callers assert this before calling).
 *   - The seed SHA must match what plugins.sha would record.
 *   - We copy, never symlink.
 *   - The target codexHome's .tmp/plugins/ is populated fresh; no merging.
 *
 * Returns:
 *   "applied"  — seed copied successfully.
 *   "skipped"  — seed dir is absent or fails integrity check.
 *   "already_present" — codexHome already has a .tmp/plugins/ tree.
 */
export async function applyPluginSeed(opts: {
  codexHome: string;
  seedDir: string;
  pluginsSha: string;
  isRestricted: boolean;
  onLog?: OnLog;
}): Promise<"applied" | "skipped" | "already_present"> {
  const { codexHome, seedDir, pluginsSha, isRestricted, onLog } = opts;

  // Never apply to restricted runs — enforced unconditionally.
  if (isRestricted) return "skipped";

  const targetPluginsDir = path.join(codexHome, ".tmp", "plugins");
  const targetShaFile = path.join(codexHome, ".tmp", "plugins.sha");

  // Skip if target already has a plugins tree.
  try {
    await fs.access(targetPluginsDir);
    return "already_present";
  } catch {
    // Expected: not yet present.
  }

  // Verify seed integrity before consuming.
  if (!(await _seedPassesIntegrityCheck(seedDir, pluginsSha))) {
    await onLog?.("stderr", `[paperclip] Plugin seed integrity check failed for SHA ${pluginsSha.slice(0, 12)}; skipping seed (Codex will re-fetch).\n`);
    return "skipped";
  }

  try {
    await fs.mkdir(path.join(codexHome, ".tmp"), { recursive: true });
    // Copy immutable seed into run home. The copy is writable so Codex can update it.
    await _cpR(seedDir, targetPluginsDir, { skipSentinel: true });
    // Write the sha file so Codex's sync check passes.
    await fs.writeFile(targetShaFile, pluginsSha + "\n");

    await onLog?.("stdout", `[paperclip] Applied plugin seed (SHA ${pluginsSha.slice(0, 12)}) into Codex home "${codexHome}".\n`);
    return "applied";
  } catch (err) {
    // Clean up partial copy on failure — Codex will re-fetch.
    await fs.rm(targetPluginsDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(targetShaFile, { force: true }).catch(() => {});
    await onLog?.("stderr", `[paperclip] Plugin seed apply failed (${(err as Error).message}); Codex will re-fetch.\n`);
    return "skipped";
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────

async function _seedPassesIntegrityCheck(seedDir: string, pluginsSha: string): Promise<boolean> {
  try {
    const sentinelPath = path.join(seedDir, SENTINEL_FILE);
    const raw = await fs.readFile(sentinelPath, "utf8");
    const sentinel = JSON.parse(raw) as Record<string, unknown>;
    return sentinel.pluginsSha === pluginsSha && sentinel.schemaVersion === SEED_SCHEMA_VERSION;
  } catch {
    return false;
  }
}

async function _cpR(src: string, dst: string, opts?: { skipSentinel?: boolean }): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (opts?.skipSentinel && entry.name === SENTINEL_FILE) continue;
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await _cpR(srcPath, dstPath, opts);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      await fs.copyFile(srcPath, dstPath);
    }
  }
}

async function _chmodReadOnly(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await _chmodReadOnly(p);
      // Dir: r-xr-xr-x (0o555)
      await fs.chmod(p, 0o555);
    } else {
      // File: r--r--r-- (0o444)
      await fs.chmod(p, 0o444);
    }
  }
  // Root dir itself last.
  await fs.chmod(dir, 0o555);
}
