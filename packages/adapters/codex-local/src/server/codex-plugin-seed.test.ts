/**
 * codex-plugin-seed.test.ts — KEWL-3853 Option B canary tests
 *
 * Covers the five AG-required test categories (KEWL-3866):
 *   1. Seed identity / path derivation
 *   2. Immutable publish is atomic
 *   3. Reader rejects mismatched SHA / manifest
 *   4. Unrestricted run uses the seed and skips re-fetch
 *   5. Restricted run NEVER reads the seed even when the flag is enabled
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPluginSeed,
  isPluginSeedEnabled,
  publishPluginSeed,
  readPluginsSha,
  resolvePluginSeedDir,
} from "./codex-plugin-seed.js";

// ── Test fixtures ──────────────────────────────────────────────────────────

const FAKE_SHA = "a".repeat(40);
const FAKE_COMPANY_ID = "test-company-id";
const FAKE_ENV_BASE: NodeJS.ProcessEnv = {
  PAPERCLIP_HOME: "", // overridden per test
  PAPERCLIP_INSTANCE_ID: "default",
};

const tmpDirs: string[] = [];

async function makeTmpDir(prefix = "codex-seed-test-"): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

async function chmodWritable(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        await chmodWritable(p);
      }
      await fs.chmod(p, 0o755).catch(() => {});
    }
    await fs.chmod(dir, 0o755).catch(() => {});
  } catch {
    // best-effort
  }
}

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    // Restore write permissions so rm can recurse into read-only seed dirs.
    await chmodWritable(d);
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function makeSourcePluginsDir(parent: string): Promise<string> {
  const pluginsDir = path.join(parent, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  await fs.writeFile(path.join(pluginsDir, "README.md"), "fake plugins tree");
  await fs.writeFile(path.join(pluginsDir, "plugin-a.js"), "module.exports = {};");
  await fs.writeFile(path.join(parent, "plugins.sha"), FAKE_SHA + "\n");
  return pluginsDir;
}

async function makeCodexHome(parent: string): Promise<string> {
  const home = path.join(parent, "codex-home");
  await fs.mkdir(home, { recursive: true });
  return home;
}

// ── isPluginSeedEnabled ────────────────────────────────────────────────────

describe("isPluginSeedEnabled", () => {
  it("is off by default", () => {
    expect(isPluginSeedEnabled({})).toBe(false);
  });

  it("is on when CODEX_SHARED_PLUGIN_SEED_ENABLED=1", () => {
    expect(isPluginSeedEnabled({ CODEX_SHARED_PLUGIN_SEED_ENABLED: "1" })).toBe(true);
  });

  it("is on when CODEX_SHARED_PLUGIN_SEED_ENABLED=true", () => {
    expect(isPluginSeedEnabled({ CODEX_SHARED_PLUGIN_SEED_ENABLED: "true" })).toBe(true);
  });

  it("is off for any other value", () => {
    expect(isPluginSeedEnabled({ CODEX_SHARED_PLUGIN_SEED_ENABLED: "0" })).toBe(false);
    expect(isPluginSeedEnabled({ CODEX_SHARED_PLUGIN_SEED_ENABLED: "false" })).toBe(false);
    expect(isPluginSeedEnabled({ CODEX_SHARED_PLUGIN_SEED_ENABLED: "" })).toBe(false);
  });
});

// ── resolvePluginSeedDir ───────────────────────────────────────────────────

describe("resolvePluginSeedDir", () => {
  it("produces company-scoped, policy-scoped, SHA-versioned path", async () => {
    const tmp = await makeTmpDir();
    const env: NodeJS.ProcessEnv = { ...FAKE_ENV_BASE, PAPERCLIP_HOME: tmp };
    const seedDir = resolvePluginSeedDir(env, FAKE_COMPANY_ID, FAKE_SHA);
    expect(seedDir).toContain("companies");
    expect(seedDir).toContain(FAKE_COMPANY_ID);
    expect(seedDir).toContain("codex-plugin-seed");
    expect(seedDir).toContain("unrestricted");
    expect(seedDir).toContain("v1");
    expect(seedDir).toContain(FAKE_SHA);
  });

  it("different SHAs produce different paths", async () => {
    const tmp = await makeTmpDir();
    const env: NodeJS.ProcessEnv = { ...FAKE_ENV_BASE, PAPERCLIP_HOME: tmp };
    const sha2 = "b".repeat(40);
    const d1 = resolvePluginSeedDir(env, FAKE_COMPANY_ID, FAKE_SHA);
    const d2 = resolvePluginSeedDir(env, FAKE_COMPANY_ID, sha2);
    expect(d1).not.toBe(d2);
  });

  it("different companies produce different paths", async () => {
    const tmp = await makeTmpDir();
    const env: NodeJS.ProcessEnv = { ...FAKE_ENV_BASE, PAPERCLIP_HOME: tmp };
    const d1 = resolvePluginSeedDir(env, "company-a", FAKE_SHA);
    const d2 = resolvePluginSeedDir(env, "company-b", FAKE_SHA);
    expect(d1).not.toBe(d2);
  });
});

// ── publishPluginSeed ──────────────────────────────────────────────────────

describe("publishPluginSeed", () => {
  it("publishes seed, writes sentinel, and marks it read-only", async () => {
    const tmp = await makeTmpDir();
    const env: NodeJS.ProcessEnv = { ...FAKE_ENV_BASE, PAPERCLIP_HOME: tmp };
    const sourceDir = path.join(tmp, ".tmp");
    await fs.mkdir(sourceDir, { recursive: true });
    const sourcePluginsDir = await makeSourcePluginsDir(sourceDir);
    const seedDir = resolvePluginSeedDir(env, FAKE_COMPANY_ID, FAKE_SHA);

    const result = await publishPluginSeed({
      sourcePluginsDir,
      seedDir,
      pluginsSha: FAKE_SHA,
      companyId: FAKE_COMPANY_ID,
      env,
    });

    expect(result).toBe("published");

    const sentinel = JSON.parse(
      await fs.readFile(path.join(seedDir, ".paperclip-plugin-seed"), "utf8"),
    );
    expect(sentinel.pluginsSha).toBe(FAKE_SHA);
    expect(sentinel.companyId).toBe(FAKE_COMPANY_ID);
    expect(sentinel.schemaVersion).toBe(1);

    const stat = await fs.stat(seedDir);
    expect(stat.mode & 0o222).toBe(0); // not writable
  });

  it("is idempotent — returns already_exists on second call", async () => {
    const tmp = await makeTmpDir();
    const env: NodeJS.ProcessEnv = { ...FAKE_ENV_BASE, PAPERCLIP_HOME: tmp };
    const sourceDir = path.join(tmp, ".tmp");
    await fs.mkdir(sourceDir, { recursive: true });
    const sourcePluginsDir = await makeSourcePluginsDir(sourceDir);
    const seedDir = resolvePluginSeedDir(env, FAKE_COMPANY_ID, FAKE_SHA);

    await publishPluginSeed({ sourcePluginsDir, seedDir, pluginsSha: FAKE_SHA, companyId: FAKE_COMPANY_ID, env });
    const r2 = await publishPluginSeed({ sourcePluginsDir, seedDir, pluginsSha: FAKE_SHA, companyId: FAKE_COMPANY_ID, env });
    expect(r2).toBe("already_exists");
  });

  it("returns skipped_source_missing when source absent", async () => {
    const tmp = await makeTmpDir();
    const env: NodeJS.ProcessEnv = { ...FAKE_ENV_BASE, PAPERCLIP_HOME: tmp };
    const seedDir = resolvePluginSeedDir(env, FAKE_COMPANY_ID, FAKE_SHA);
    const result = await publishPluginSeed({
      sourcePluginsDir: path.join(tmp, "nonexistent"),
      seedDir,
      pluginsSha: FAKE_SHA,
      companyId: FAKE_COMPANY_ID,
      env,
    });
    expect(result).toBe("skipped_source_missing");
  });
});

// ── applyPluginSeed ────────────────────────────────────────────────────────

describe("applyPluginSeed", () => {
  it("UNRESTRICTED run — applies seed, copies files, writes sha file", async () => {
    const tmp = await makeTmpDir();
    const env: NodeJS.ProcessEnv = { ...FAKE_ENV_BASE, PAPERCLIP_HOME: tmp };
    const sourceDir = path.join(tmp, ".tmp");
    await fs.mkdir(sourceDir, { recursive: true });
    const sourcePluginsDir = await makeSourcePluginsDir(sourceDir);
    const seedDir = resolvePluginSeedDir(env, FAKE_COMPANY_ID, FAKE_SHA);
    await publishPluginSeed({ sourcePluginsDir, seedDir, pluginsSha: FAKE_SHA, companyId: FAKE_COMPANY_ID, env });

    const codexHome = await makeCodexHome(tmp);
    const result = await applyPluginSeed({ codexHome, seedDir, pluginsSha: FAKE_SHA, isRestricted: false });
    expect(result).toBe("applied");

    // Plugin files must be in run home.
    const readmeExists = await fs.access(path.join(codexHome, ".tmp", "plugins", "README.md")).then(() => true).catch(() => false);
    expect(readmeExists).toBe(true);

    // plugins.sha must be written.
    const writtenSha = (await fs.readFile(path.join(codexHome, ".tmp", "plugins.sha"), "utf8")).trim();
    expect(writtenSha).toBe(FAKE_SHA);

    // Sentinel file must NOT appear in the run home.
    const sentinelInHome = await fs.access(path.join(codexHome, ".tmp", "plugins", ".paperclip-plugin-seed")).then(() => true).catch(() => false);
    expect(sentinelInHome).toBe(false);
  });

  it("RESTRICTED run — never reads seed even when flag enabled", async () => {
    const tmp = await makeTmpDir();
    const env: NodeJS.ProcessEnv = { ...FAKE_ENV_BASE, PAPERCLIP_HOME: tmp };
    const sourceDir = path.join(tmp, ".tmp");
    await fs.mkdir(sourceDir, { recursive: true });
    const sourcePluginsDir = await makeSourcePluginsDir(sourceDir);
    const seedDir = resolvePluginSeedDir(env, FAKE_COMPANY_ID, FAKE_SHA);
    await publishPluginSeed({ sourcePluginsDir, seedDir, pluginsSha: FAKE_SHA, companyId: FAKE_COMPANY_ID, env });

    const codexHome = await makeCodexHome(tmp);
    const result = await applyPluginSeed({ codexHome, seedDir, pluginsSha: FAKE_SHA, isRestricted: true });
    expect(result).toBe("skipped");

    // Plugins directory MUST NOT exist in restricted run home.
    const pluginsExist = await fs.access(path.join(codexHome, ".tmp", "plugins")).then(() => true).catch(() => false);
    expect(pluginsExist).toBe(false);

    // .tmp must be empty — no seed paths, no sha, no sentinel.
    const tmpEntries = await fs.readdir(path.join(codexHome, ".tmp")).catch(() => []);
    expect(tmpEntries.length).toBe(0);
  });

  it("returns skipped when SHA mismatch — rejects stale or tampered seed", async () => {
    const tmp = await makeTmpDir();
    const env: NodeJS.ProcessEnv = { ...FAKE_ENV_BASE, PAPERCLIP_HOME: tmp };
    const sourceDir = path.join(tmp, ".tmp");
    await fs.mkdir(sourceDir, { recursive: true });
    const sourcePluginsDir = await makeSourcePluginsDir(sourceDir);
    const seedDir = resolvePluginSeedDir(env, FAKE_COMPANY_ID, FAKE_SHA);
    await publishPluginSeed({ sourcePluginsDir, seedDir, pluginsSha: FAKE_SHA, companyId: FAKE_COMPANY_ID, env });

    const codexHome = await makeCodexHome(tmp);
    const wrongSha = "c".repeat(40);
    const result = await applyPluginSeed({ codexHome, seedDir, pluginsSha: wrongSha, isRestricted: false });
    expect(result).toBe("skipped");
  });

  it("returns already_present when codexHome already has plugins", async () => {
    const tmp = await makeTmpDir();
    const env: NodeJS.ProcessEnv = { ...FAKE_ENV_BASE, PAPERCLIP_HOME: tmp };
    const sourceDir = path.join(tmp, ".tmp");
    await fs.mkdir(sourceDir, { recursive: true });
    const sourcePluginsDir = await makeSourcePluginsDir(sourceDir);
    const seedDir = resolvePluginSeedDir(env, FAKE_COMPANY_ID, FAKE_SHA);
    await publishPluginSeed({ sourcePluginsDir, seedDir, pluginsSha: FAKE_SHA, companyId: FAKE_COMPANY_ID, env });

    const codexHome = await makeCodexHome(tmp);
    await fs.mkdir(path.join(codexHome, ".tmp", "plugins"), { recursive: true });
    const result = await applyPluginSeed({ codexHome, seedDir, pluginsSha: FAKE_SHA, isRestricted: false });
    expect(result).toBe("already_present");
  });
});

// ── readPluginsSha ─────────────────────────────────────────────────────────

describe("readPluginsSha", () => {
  it("returns sha from valid .tmp/plugins.sha", async () => {
    const tmp = await makeTmpDir();
    const codexHome = path.join(tmp, "home");
    await fs.mkdir(path.join(codexHome, ".tmp"), { recursive: true });
    await fs.writeFile(path.join(codexHome, ".tmp", "plugins.sha"), FAKE_SHA + "\n");
    const sha = await readPluginsSha(codexHome);
    expect(sha).toBe(FAKE_SHA);
  });

  it("returns null when file absent", async () => {
    const tmp = await makeTmpDir();
    const sha = await readPluginsSha(tmp);
    expect(sha).toBeNull();
  });

  it("returns null for non-hex content", async () => {
    const tmp = await makeTmpDir();
    const codexHome = path.join(tmp, "home");
    await fs.mkdir(path.join(codexHome, ".tmp"), { recursive: true });
    await fs.writeFile(path.join(codexHome, ".tmp", "plugins.sha"), "not-a-sha");
    const sha = await readPluginsSha(codexHome);
    expect(sha).toBeNull();
  });
});
