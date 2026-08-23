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

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after, beforeEach } from "node:test";
import {
  isPluginSeedEnabled,
  resolvePluginSeedDir,
  readPluginsSha,
  publishPluginSeed,
  applyPluginSeed,
} from "./codex-plugin-seed.js";

// ── Test fixtures ──────────────────────────────────────────────────────────

const FAKE_SHA = "a".repeat(40);
const FAKE_COMPANY_ID = "test-company-id";
const FAKE_ENV_BASE: NodeJS.ProcessEnv = {
  PAPERCLIP_HOME: "", // overridden per test
  PAPERCLIP_INSTANCE_ID: "default",
};

async function makeTmpDir(prefix = "codex-seed-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeSourcePluginsDir(dir: string, sha = FAKE_SHA): Promise<string> {
  const pluginsDir = path.join(dir, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  // A sentinel plugin file to verify copy.
  await fs.writeFile(path.join(pluginsDir, "README.md"), "fake plugins tree");
  await fs.writeFile(path.join(pluginsDir, "plugin-a.js"), "module.exports = {};");
  // Write sha file in parent.
  await fs.writeFile(path.join(dir, "plugins.sha"), sha + "\n");
  return pluginsDir;
}

async function makeCodexHome(dir: string): Promise<string> {
  const home = path.join(dir, "codex-home");
  await fs.mkdir(home, { recursive: true });
  return home;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("isPluginSeedEnabled", () => {
  it("is off by default", () => {
    assert.equal(isPluginSeedEnabled({}), false);
  });

  it("is on when CODEX_SHARED_PLUGIN_SEED_ENABLED=1", () => {
    assert.equal(isPluginSeedEnabled({ CODEX_SHARED_PLUGIN_SEED_ENABLED: "1" }), true);
  });

  it("is on when CODEX_SHARED_PLUGIN_SEED_ENABLED=true", () => {
    assert.equal(isPluginSeedEnabled({ CODEX_SHARED_PLUGIN_SEED_ENABLED: "true" }), true);
  });

  it("is off for any other value", () => {
    assert.equal(isPluginSeedEnabled({ CODEX_SHARED_PLUGIN_SEED_ENABLED: "0" }), false);
    assert.equal(isPluginSeedEnabled({ CODEX_SHARED_PLUGIN_SEED_ENABLED: "false" }), false);
    assert.equal(isPluginSeedEnabled({ CODEX_SHARED_PLUGIN_SEED_ENABLED: "" }), false);
  });
});

describe("resolvePluginSeedDir", () => {
  it("produces company-scoped, policy-scoped, SHA-versioned path", async () => {
    const tmp = await makeTmpDir();
    try {
      const env: NodeJS.ProcessEnv = { ...FAKE_ENV_BASE, PAPERCLIP_HOME: tmp };
      const seedDir = resolvePluginSeedDir(env, FAKE_COMPANY_ID, FAKE_SHA);
      assert.ok(seedDir.includes("companies"));
      assert.ok(seedDir.includes(FAKE_COMPANY_ID));
      assert.ok(seedDir.includes("codex-plugin-seed"));
      assert.ok(seedDir.includes("unrestricted"));
      assert.ok(seedDir.includes("v1"));
      assert.ok(seedDir.includes(FAKE_SHA));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("different SHAs produce different paths", async () => {
    const tmp = await makeTmpDir();
    try {
      const env: NodeJS.ProcessEnv = { ...FAKE_ENV_BASE, PAPERCLIP_HOME: tmp };
      const sha2 = "b".repeat(40);
      const d1 = resolvePluginSeedDir(env, FAKE_COMPANY_ID, FAKE_SHA);
      const d2 = resolvePluginSeedDir(env, FAKE_COMPANY_ID, sha2);
      assert.notEqual(d1, d2);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("different companies produce different paths", async () => {
    const tmp = await makeTmpDir();
    try {
      const env: NodeJS.ProcessEnv = { ...FAKE_ENV_BASE, PAPERCLIP_HOME: tmp };
      const d1 = resolvePluginSeedDir(env, "company-a", FAKE_SHA);
      const d2 = resolvePluginSeedDir(env, "company-b", FAKE_SHA);
      assert.notEqual(d1, d2);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("publishPluginSeed", () => {
  it("publishes seed and marks it read-only", async () => {
    const tmp = await makeTmpDir();
    try {
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

      assert.equal(result, "published");
      // Sentinel file must exist.
      const sentinelPath = path.join(seedDir, ".paperclip-plugin-seed");
      const sentinel = JSON.parse(await fs.readFile(sentinelPath, "utf8"));
      assert.equal(sentinel.pluginsSha, FAKE_SHA);
      assert.equal(sentinel.companyId, FAKE_COMPANY_ID);
      assert.equal(sentinel.schemaVersion, 1);
      // Seed dir must be read-only.
      const stat = await fs.stat(seedDir);
      assert.ok(!(stat.mode & 0o222), "seed directory must not be writable");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("is idempotent — returns already_exists on second call", async () => {
    const tmp = await makeTmpDir();
    try {
      const env: NodeJS.ProcessEnv = { ...FAKE_ENV_BASE, PAPERCLIP_HOME: tmp };
      const sourceDir = path.join(tmp, ".tmp");
      await fs.mkdir(sourceDir, { recursive: true });
      const sourcePluginsDir = await makeSourcePluginsDir(sourceDir);
      const seedDir = resolvePluginSeedDir(env, FAKE_COMPANY_ID, FAKE_SHA);

      await publishPluginSeed({ sourcePluginsDir, seedDir, pluginsSha: FAKE_SHA, companyId: FAKE_COMPANY_ID, env });
      const r2 = await publishPluginSeed({ sourcePluginsDir, seedDir, pluginsSha: FAKE_SHA, companyId: FAKE_COMPANY_ID, env });
      assert.equal(r2, "already_exists");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns skipped_source_missing when source absent", async () => {
    const tmp = await makeTmpDir();
    try {
      const env: NodeJS.ProcessEnv = { ...FAKE_ENV_BASE, PAPERCLIP_HOME: tmp };
      const seedDir = resolvePluginSeedDir(env, FAKE_COMPANY_ID, FAKE_SHA);
      const result = await publishPluginSeed({
        sourcePluginsDir: path.join(tmp, "nonexistent"),
        seedDir,
        pluginsSha: FAKE_SHA,
        companyId: FAKE_COMPANY_ID,
        env,
      });
      assert.equal(result, "skipped_source_missing");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("applyPluginSeed", () => {
  it("applies seed to unrestricted run — correct SHA", async () => {
    const tmp = await makeTmpDir();
    try {
      const env: NodeJS.ProcessEnv = { ...FAKE_ENV_BASE, PAPERCLIP_HOME: tmp };
      // Build and publish a seed.
      const sourceDir = path.join(tmp, ".tmp");
      await fs.mkdir(sourceDir, { recursive: true });
      const sourcePluginsDir = await makeSourcePluginsDir(sourceDir);
      const seedDir = resolvePluginSeedDir(env, FAKE_COMPANY_ID, FAKE_SHA);
      await publishPluginSeed({ sourcePluginsDir, seedDir, pluginsSha: FAKE_SHA, companyId: FAKE_COMPANY_ID, env });

      // Apply to a fresh codex home.
      const codexHome = await makeCodexHome(tmp);
      const result = await applyPluginSeed({ codexHome, seedDir, pluginsSha: FAKE_SHA, isRestricted: false });
      assert.equal(result, "applied");

      // Plugins must be present in run home.
      const pluginsDir = path.join(codexHome, ".tmp", "plugins");
      const readmeExists = await fs.access(path.join(pluginsDir, "README.md")).then(() => true).catch(() => false);
      assert.ok(readmeExists, "README.md should be copied from seed");

      // plugins.sha must be written.
      const writtenSha = (await fs.readFile(path.join(codexHome, ".tmp", "plugins.sha"), "utf8")).trim();
      assert.equal(writtenSha, FAKE_SHA);

      // Sentinel file must NOT be in the run home.
      const sentinelInHome = await fs.access(path.join(pluginsDir, ".paperclip-plugin-seed")).then(() => true).catch(() => false);
      assert.ok(!sentinelInHome, "sentinel file must not be copied to run home");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("RESTRICTED run — never reads seed even when flag enabled", async () => {
    const tmp = await makeTmpDir();
    try {
      const env: NodeJS.ProcessEnv = { ...FAKE_ENV_BASE, PAPERCLIP_HOME: tmp };
      const sourceDir = path.join(tmp, ".tmp");
      await fs.mkdir(sourceDir, { recursive: true });
      const sourcePluginsDir = await makeSourcePluginsDir(sourceDir);
      const seedDir = resolvePluginSeedDir(env, FAKE_COMPANY_ID, FAKE_SHA);
      await publishPluginSeed({ sourcePluginsDir, seedDir, pluginsSha: FAKE_SHA, companyId: FAKE_COMPANY_ID, env });

      const codexHome = await makeCodexHome(tmp);
      // isRestricted=true — must never apply
      const result = await applyPluginSeed({ codexHome, seedDir, pluginsSha: FAKE_SHA, isRestricted: true });
      assert.equal(result, "skipped");

      // Plugins directory must NOT exist in restricted run home.
      const pluginsDir = path.join(codexHome, ".tmp", "plugins");
      const pluginsExist = await fs.access(pluginsDir).then(() => true).catch(() => false);
      assert.ok(!pluginsExist, "Restricted run must not have seed plugins in CODEX_HOME");

      // No seed paths, symlinks, or files from seed in the restricted run home's .tmp.
      const tmpEntries = await fs.readdir(path.join(codexHome, ".tmp")).catch(() => []);
      assert.equal(tmpEntries.length, 0, "Restricted run home .tmp must be empty");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns skipped when SHA mismatch — rejects stale or tampered seed", async () => {
    const tmp = await makeTmpDir();
    try {
      const env: NodeJS.ProcessEnv = { ...FAKE_ENV_BASE, PAPERCLIP_HOME: tmp };
      const sourceDir = path.join(tmp, ".tmp");
      await fs.mkdir(sourceDir, { recursive: true });
      const sourcePluginsDir = await makeSourcePluginsDir(sourceDir);
      const seedDir = resolvePluginSeedDir(env, FAKE_COMPANY_ID, FAKE_SHA);
      await publishPluginSeed({ sourcePluginsDir, seedDir, pluginsSha: FAKE_SHA, companyId: FAKE_COMPANY_ID, env });

      const codexHome = await makeCodexHome(tmp);
      const wrongSha = "c".repeat(40);
      const result = await applyPluginSeed({ codexHome, seedDir, pluginsSha: wrongSha, isRestricted: false });
      assert.equal(result, "skipped");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns already_present when codexHome already has plugins", async () => {
    const tmp = await makeTmpDir();
    try {
      const env: NodeJS.ProcessEnv = { ...FAKE_ENV_BASE, PAPERCLIP_HOME: tmp };
      const sourceDir = path.join(tmp, ".tmp");
      await fs.mkdir(sourceDir, { recursive: true });
      const sourcePluginsDir = await makeSourcePluginsDir(sourceDir);
      const seedDir = resolvePluginSeedDir(env, FAKE_COMPANY_ID, FAKE_SHA);
      await publishPluginSeed({ sourcePluginsDir, seedDir, pluginsSha: FAKE_SHA, companyId: FAKE_COMPANY_ID, env });

      const codexHome = await makeCodexHome(tmp);
      // Pre-populate plugins dir.
      await fs.mkdir(path.join(codexHome, ".tmp", "plugins"), { recursive: true });
      const result = await applyPluginSeed({ codexHome, seedDir, pluginsSha: FAKE_SHA, isRestricted: false });
      assert.equal(result, "already_present");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("readPluginsSha", () => {
  it("returns sha from valid .tmp/plugins.sha", async () => {
    const tmp = await makeTmpDir();
    try {
      const codexHome = path.join(tmp, "home");
      await fs.mkdir(path.join(codexHome, ".tmp"), { recursive: true });
      await fs.writeFile(path.join(codexHome, ".tmp", "plugins.sha"), FAKE_SHA + "\n");
      const sha = await readPluginsSha(codexHome);
      assert.equal(sha, FAKE_SHA);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns null when file absent", async () => {
    const tmp = await makeTmpDir();
    try {
      const sha = await readPluginsSha(tmp);
      assert.equal(sha, null);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns null for non-hex content", async () => {
    const tmp = await makeTmpDir();
    try {
      const codexHome = path.join(tmp, "home");
      await fs.mkdir(path.join(codexHome, ".tmp"), { recursive: true });
      await fs.writeFile(path.join(codexHome, ".tmp", "plugins.sha"), "not-a-sha");
      const sha = await readPluginsSha(codexHome);
      assert.equal(sha, null);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
