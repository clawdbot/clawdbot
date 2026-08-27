// Covers installed plugin index record parsing and normalization.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createPluginInstallRecordMap,
  getPluginInstallRecordMapEntry,
  setPluginInstallRecordMapEntry,
} from "../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  OPENCLAW_STATE_SCHEMA_VERSION,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { recordPluginCandidateInstallOwner } from "./candidate-install-owner.js";
import type { PluginCandidate } from "./discovery.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
} from "./install-paths.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords,
  loadInstalledPluginIndexInstallRecordsSync,
  readPersistedInstalledPluginIndexInstallRecords,
  recordPluginInstallInRecords,
  removePluginInstallRecordFromRecords,
  resolveInstalledPluginIndexRecordsStorePath,
  withoutPluginInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecordsSync,
} from "./installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs = createTempDirTracker();

function createPluginCandidate(stateDir: string, pluginId: string): PluginCandidate {
  const rootDir = path.join(stateDir, "plugins", pluginId);
  fs.mkdirSync(rootDir, { recursive: true });
  const source = path.join(rootDir, "index.ts");
  fs.writeFileSync(source, "export function register() {}\n", "utf8");
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      configSchema: { type: "object" },
    }),
    "utf8",
  );
  return recordPluginCandidateInstallOwner(
    {
      idHint: pluginId,
      source,
      rootDir,
      origin: "global",
    },
    pluginId,
  );
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function updatePersistedInstallRecordsWithoutClearingCache(
  stateDir: string,
  records: Record<string, PluginInstallRecord>,
) {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const now = Date.now();
      db.prepare(
        `
          UPDATE config_machine_state
             SET value_json = json_set(
                   value_json,
                   '$.index.installRecords', json(?),
                   '$.revision', ?
                 ),
                 updated_at_ms = ?
           WHERE state_key = 'plugins.installedIndex'
        `,
      ).run(JSON.stringify(records), now, now);
    },
    { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
  );
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.doUnmock("./installed-plugin-index-store.js");
  clearLoadInstalledPluginIndexInstallRecordsCache();
  tempDirs.cleanup();
});

describe("plugin index install records store", () => {
  it("writes machine-managed install records outside config", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const candidate = createPluginCandidate(stateDir, "twitch");

    await writePersistedInstalledPluginIndexInstallRecords(
      {
        twitch: {
          source: "npm",
          spec: "@openclaw/plugin-twitch@1.0.0",
          installPath: "plugins/npm/@openclaw/plugin-twitch",
        },
      },
      {
        stateDir,
        candidates: [candidate],
        now: () => new Date(1777118400000),
      },
    );

    const indexPath = resolveInstalledPluginIndexRecordsStorePath({ stateDir });
    expect(indexPath).toBe(path.join(stateDir, "state", "openclaw.sqlite"));
    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    if (!persisted) {
      throw new Error("Expected persisted plugin index");
    }
    expect(persisted.version).toBe(1);
    expect(persisted.generatedAtMs).toBe(1777118400000);
    expectRecordFields(persisted.installRecords?.twitch, {
      source: "npm",
      spec: "@openclaw/plugin-twitch@1.0.0",
      installPath: "plugins/npm/@openclaw/plugin-twitch",
    });
    expect(persisted.plugins).toHaveLength(1);
    expect(persisted.plugins?.[0]?.pluginId).toBe("twitch");
    expect(persisted.plugins?.[0]?.installRecordHash).toMatch(/^[a-f0-9]{64}$/u);
    await expect(readPersistedInstalledPluginIndexInstallRecords({ stateDir })).resolves.toEqual({
      twitch: {
        source: "npm",
        spec: "@openclaw/plugin-twitch@1.0.0",
        installPath: "plugins/npm/@openclaw/plugin-twitch",
      },
    });
  });

  it("preserves install records for plugins without a discovered manifest", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");

    await writePersistedInstalledPluginIndexInstallRecords(
      {
        missing: {
          source: "npm",
          spec: "missing-plugin@1.0.0",
          installPath: path.join(stateDir, "plugins", "missing"),
        },
      },
      {
        stateDir,
        candidates: [],
        now: () => new Date(1777118400000),
      },
    );

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    if (!persisted) {
      throw new Error("Expected persisted plugin index");
    }
    expectRecordFields(persisted.installRecords?.missing, {
      source: "npm",
      spec: "missing-plugin@1.0.0",
      installPath: path.join(stateDir, "plugins", "missing"),
    });
    expect(persisted.plugins).toEqual([]);
    await expect(loadInstalledPluginIndexInstallRecords({ stateDir })).resolves.toEqual({
      missing: {
        source: "npm",
        spec: "missing-plugin@1.0.0",
        installPath: path.join(stateDir, "plugins", "missing"),
      },
    });
  });

  it("reads persisted records from the plugin index", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const candidate = createPluginCandidate(stateDir, "persisted");
    await writePersistedInstalledPluginIndexInstallRecords(
      {
        persisted: {
          source: "npm",
          spec: "persisted@1.0.0",
        },
      },
      { stateDir, candidates: [candidate] },
    );

    await expect(
      loadInstalledPluginIndexInstallRecords({
        stateDir,
      }),
    ).resolves.toEqual({
      persisted: {
        source: "npm",
        spec: "persisted@1.0.0",
      },
    });
  });

  it("preserves newer shared-state schema errors while loading install records", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    await writePersistedInstalledPluginIndexInstallRecords(
      {
        persisted: {
          source: "npm",
          spec: "persisted@1.0.0",
        },
      },
      { stateDir, candidates: [] },
    );
    closeOpenClawStateDatabaseForTest();
    const databasePath = resolveInstalledPluginIndexRecordsStorePath({ stateDir });
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    database.close();

    expect(() => loadInstalledPluginIndexInstallRecordsSync({ stateDir })).toThrow(
      expect.objectContaining({
        name: "SqliteSchemaVersionError",
        message: expect.stringContaining(
          `uses newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`,
        ),
      }),
    );
  });

  it("returns prototype-safe map copies without cloning cached records", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const candidate = createPluginCandidate(stateDir, "cached");
    await writePersistedInstalledPluginIndexInstallRecords(
      {
        cached: {
          source: "npm",
          spec: "cached@1.0.0",
        },
      },
      { stateDir, candidates: [candidate] },
    );

    const first = loadInstalledPluginIndexInstallRecordsSync({ stateDir });
    const second = loadInstalledPluginIndexInstallRecordsSync({ stateDir });

    expect(first).not.toBe(second);
    expect(Object.getPrototypeOf(first)).toBeNull();
    expect(Object.getPrototypeOf(second)).toBeNull();
    expect(expectDefined(first.cached, "first.cached test invariant")).toBe(
      expectDefined(second.cached, "second.cached test invariant"),
    );
  });

  it("invalidates cached records when the persisted index is rewritten", () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const first = createPluginCandidate(stateDir, "first");
    writePersistedInstalledPluginIndexInstallRecordsSync(
      {
        first: {
          source: "npm",
          spec: "first@1.0.0",
        },
      },
      { stateDir, candidates: [first] },
    );
    expect(loadInstalledPluginIndexInstallRecordsSync({ stateDir })).toEqual({
      first: {
        source: "npm",
        spec: "first@1.0.0",
      },
    });

    const second = createPluginCandidate(stateDir, "second");
    writePersistedInstalledPluginIndexInstallRecordsSync(
      {
        second: {
          source: "npm",
          spec: "second@1.0.0",
        },
      },
      { stateDir, candidates: [second] },
    );

    expect(loadInstalledPluginIndexInstallRecordsSync({ stateDir })).toEqual({
      second: {
        source: "npm",
        spec: "second@1.0.0",
      },
    });
  });

  it("keeps cached records until cache clear after an external index write", () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const candidate = createPluginCandidate(stateDir, "external");
    writePersistedInstalledPluginIndexInstallRecordsSync(
      {
        external: {
          source: "npm",
          spec: "external@1.0.0",
        },
      },
      { stateDir, candidates: [candidate] },
    );
    expect(loadInstalledPluginIndexInstallRecordsSync({ stateDir })).toEqual({
      external: {
        source: "npm",
        spec: "external@1.0.0",
      },
    });

    updatePersistedInstallRecordsWithoutClearingCache(stateDir, {
      external: {
        source: "npm",
        spec: "external-plugin@2.0.0",
      },
    });

    expect(loadInstalledPluginIndexInstallRecordsSync({ stateDir })).toEqual({
      external: {
        source: "npm",
        spec: "external@1.0.0",
      },
    });

    clearLoadInstalledPluginIndexInstallRecordsCache();

    expect(loadInstalledPluginIndexInstallRecordsSync({ stateDir })).toEqual({
      external: {
        source: "npm",
        spec: "external-plugin@2.0.0",
      },
    });
  });

  it("reads persisted records when the plugin index has no plugin list", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    await writePersistedInstalledPluginIndexInstallRecords(
      {
        legacy: {
          source: "npm",
          spec: "legacy@1.0.0",
          installPath: path.join(stateDir, "plugins", "legacy"),
        },
      },
      { stateDir, candidates: [] },
    );

    await expect(loadInstalledPluginIndexInstallRecords({ stateDir })).resolves.toEqual({
      legacy: {
        source: "npm",
        spec: "legacy@1.0.0",
        installPath: path.join(stateDir, "plugins", "legacy"),
      },
    });
  });

  it("recovers managed npm plugin records when the persisted ledger is empty", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const discordDir = writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/discord",
      pluginId: "discord",
      version: "2026.5.2",
    });
    const codexDir = writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/codex",
      pluginId: "codex",
      version: "2026.5.2",
    });
    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectRecordFields(loaded.codex, {
      source: "npm",
      spec: "@openclaw/codex@2026.5.2",
      installPath: codexDir,
      version: "2026.5.2",
      resolvedName: "@openclaw/codex",
      resolvedVersion: "2026.5.2",
      resolvedSpec: "@openclaw/codex@2026.5.2",
    });
    expectRecordFields(loaded.discord, {
      source: "npm",
      spec: "@openclaw/discord@2026.5.2",
      installPath: discordDir,
      version: "2026.5.2",
      resolvedName: "@openclaw/discord",
      resolvedVersion: "2026.5.2",
      resolvedSpec: "@openclaw/discord@2026.5.2",
    });
    const loadedSync = loadInstalledPluginIndexInstallRecordsSync({ stateDir });
    expectRecordFields(loadedSync.codex, { source: "npm", installPath: codexDir });
    expectRecordFields(loadedSync.discord, { source: "npm", installPath: discordDir });
  });

  it("still recovers legacy flat managed npm plugin records", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const discordDir = writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/discord",
      pluginId: "discord",
      version: "2026.5.2",
      layout: "legacy",
    });
    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectRecordFields(loaded.discord, {
      source: "npm",
      spec: "@openclaw/discord@2026.5.2",
      installPath: discordDir,
      version: "2026.5.2",
    });
  });

  it("keeps persisted install record metadata over recovered npm records", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const customInstallPath = path.join(stateDir, "custom", "node_modules", "@openclaw", "discord");
    writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/discord",
      pluginId: "discord",
      version: "2026.5.2",
    });
    const candidate = createPluginCandidate(stateDir, "discord");
    await writePersistedInstalledPluginIndexInstallRecords(
      {
        discord: {
          source: "npm",
          spec: "@openclaw/discord@beta",
          installPath: customInstallPath,
          integrity: "sha512-persisted",
        },
      },
      { stateDir, candidates: [candidate] },
    );

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectRecordFields(loaded.discord, {
      source: "npm",
      spec: "@openclaw/discord@beta",
      installPath: customInstallPath,
      integrity: "sha512-persisted",
    });
  });

  it.each([
    {
      expectedSpec: "@openclaw/discord",
      label: "bare",
      persistedVersion: "2026.7.1",
      recoveredVersion: "2026.7.1",
      spec: "@openclaw/discord",
    },
    {
      expectedSpec: "@openclaw/discord@latest",
      label: "latest",
      persistedVersion: "2026.7.1",
      recoveredVersion: "2026.7.1",
      spec: "@openclaw/discord@latest",
    },
    {
      expectedSpec: "@openclaw/discord@beta",
      label: "dist-tag",
      persistedVersion: "2026.7.1",
      recoveredVersion: "2026.7.1",
      spec: "@openclaw/discord@beta",
    },
    {
      expectedSpec: "@openclaw/discord@2026.7.1",
      label: "obsolete exact-version",
      persistedVersion: "2026.6.4",
      recoveredVersion: "2026.7.1",
      spec: "@openclaw/discord@2026.6.4",
    },
    {
      expectedSpec: "@openclaw/discord@2027.1.0",
      label: "unsupported legacy range",
      persistedVersion: "2026.6.4",
      recoveredVersion: "2027.1.0",
      spec: "@openclaw/discord@^2026.6.0",
    },
    {
      expectedSpec: "@openclaw/discord@2026.7.2-beta.1",
      label: "bare prerelease",
      persistedVersion: "2026.7.1",
      recoveredVersion: "2026.7.2-beta.1",
      spec: "@openclaw/discord",
    },
    {
      expectedSpec: "@openclaw/discord@2026.7.2-beta.1",
      label: "latest prerelease",
      persistedVersion: "2026.7.1",
      recoveredVersion: "2026.7.2-beta.1",
      spec: "@openclaw/discord@latest",
    },
    {
      expectedSpec: "@openclaw/discord@beta",
      label: "opted-in prerelease",
      persistedVersion: "2026.7.1",
      recoveredVersion: "2026.7.2-beta.1",
      spec: "@openclaw/discord@beta",
    },
  ])(
    "recovers a valid managed generation with a compatible $label selector",
    async ({ expectedSpec, persistedVersion, recoveredVersion, spec }) => {
      const stateDir = tempDirs.make("openclaw-plugin-index-records-");
      const packageName = "@openclaw/discord";
      const fixtureProjectRoot = resolvePluginNpmProjectDir({
        npmDir: path.join(stateDir, "npm"),
        packageName,
      });
      writeManagedNpmPlugin({
        stateDir,
        packageName,
        pluginId: "discord",
        version: recoveredVersion,
      });
      const staleProjectRoot = resolvePluginNpmGenerationProjectDir({
        npmDir: path.join(stateDir, "npm"),
        packageName,
        generationKey: "discord-2026.6.4",
      });
      const activeProjectRoot = resolvePluginNpmGenerationProjectDir({
        npmDir: path.join(stateDir, "npm"),
        packageName,
        generationKey: `discord-${recoveredVersion}`,
      });
      fs.renameSync(fixtureProjectRoot, activeProjectRoot);
      const stalePackageDir = path.join(
        staleProjectRoot,
        "node_modules",
        ...packageName.split("/"),
      );
      const activePackageDir = path.join(
        activeProjectRoot,
        "node_modules",
        ...packageName.split("/"),
      );

      await writePersistedInstalledPluginIndexInstallRecords(
        {
          discord: {
            source: "npm",
            spec,
            installPath: stalePackageDir,
            version: persistedVersion,
            resolvedName: packageName,
            resolvedVersion: persistedVersion,
            resolvedSpec: `${packageName}@${persistedVersion}`,
            integrity: "sha512-stale",
          },
        },
        { stateDir, candidates: [] },
      );

      const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
      const record = expectRecordFields(loaded.discord, {
        source: "npm",
        spec: expectedSpec,
        installPath: activePackageDir,
        version: recoveredVersion,
        resolvedName: packageName,
        resolvedVersion: recoveredVersion,
        resolvedSpec: `${packageName}@${recoveredVersion}`,
      });
      expect(record.integrity).toBeUndefined();

      clearLoadInstalledPluginIndexInstallRecordsCache();
      expectRecordFields(loadInstalledPluginIndexInstallRecordsSync({ stateDir }).discord, {
        installPath: activePackageDir,
        resolvedVersion: recoveredVersion,
      });
    },
  );

  it("recovers when an ENOTDIR ancestor blocks the stale managed generation", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const packageName = "@openclaw/discord";
    const npmDir = path.join(stateDir, "npm");
    const fixtureProjectRoot = resolvePluginNpmProjectDir({ npmDir, packageName });
    writeManagedNpmPlugin({
      stateDir,
      packageName,
      pluginId: "discord",
      version: "2026.7.1",
    });
    const activeProjectRoot = resolvePluginNpmGenerationProjectDir({
      npmDir,
      packageName,
      generationKey: "discord-2026.7.1",
    });
    fs.renameSync(fixtureProjectRoot, activeProjectRoot);
    const staleProjectRoot = resolvePluginNpmGenerationProjectDir({
      npmDir,
      packageName,
      generationKey: "discord-2026.6.4",
    });
    fs.writeFileSync(staleProjectRoot, "not a directory", "utf8");
    const stalePackageDir = path.join(staleProjectRoot, "node_modules", ...packageName.split("/"));
    const activePackageDir = path.join(
      activeProjectRoot,
      "node_modules",
      ...packageName.split("/"),
    );

    await writePersistedInstalledPluginIndexInstallRecords(
      {
        discord: {
          source: "npm",
          spec: "@openclaw/discord@latest",
          installPath: stalePackageDir,
          resolvedName: packageName,
          resolvedVersion: "2026.6.4",
          integrity: "sha512-stale",
        },
      },
      { stateDir, candidates: [] },
    );

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    const record = expectRecordFields(loaded.discord, {
      spec: "@openclaw/discord@latest",
      installPath: activePackageDir,
      resolvedVersion: "2026.7.1",
    });
    expect(record.integrity).toBeUndefined();
  });

  it("recovers a Windows managed generation when the persisted root casing differs", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const packageName = "@openclaw/discord";
    const npmDir = path.join(stateDir, "npm");
    const fixtureProjectRoot = resolvePluginNpmProjectDir({ npmDir, packageName });
    writeManagedNpmPlugin({
      stateDir,
      packageName,
      pluginId: "discord",
      version: "2026.7.1",
    });
    const activeProjectRoot = resolvePluginNpmGenerationProjectDir({
      npmDir,
      packageName,
      generationKey: "discord-2026.7.1",
    });
    fs.renameSync(fixtureProjectRoot, activeProjectRoot);
    const activePackageDir = path.join(
      activeProjectRoot,
      "node_modules",
      ...packageName.split("/"),
    );
    const staleProjectRoot = resolvePluginNpmGenerationProjectDir({
      npmDir,
      packageName,
      generationKey: "discord-2026.6.4",
    });
    const stalePackageDir = path
      .join(staleProjectRoot, "node_modules", ...packageName.split("/"))
      .replace(stateDir, stateDir.toUpperCase());

    await writePersistedInstalledPluginIndexInstallRecords(
      {
        discord: {
          source: "npm",
          spec: "@openclaw/discord@latest",
          installPath: stalePackageDir,
          resolvedName: packageName,
          resolvedVersion: "2026.6.4",
        },
      },
      { stateDir, candidates: [] },
    );

    const loaded = await withMockedWindowsPlatform(() =>
      loadInstalledPluginIndexInstallRecords({ stateDir }),
    );
    expectRecordFields(loaded.discord, {
      installPath: activePackageDir,
      resolvedVersion: "2026.7.1",
    });
  });

  it("recovers managed npm metadata when the persisted record points at an older package version", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const codexDir = writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/codex",
      pluginId: "codex",
      version: "2026.5.18-beta.1",
    });
    const candidate = createPluginCandidate(stateDir, "codex");
    await writePersistedInstalledPluginIndexInstallRecords(
      {
        codex: {
          source: "npm",
          spec: "@openclaw/codex@2026.5.16-beta.1",
          installPath: codexDir,
          version: "2026.5.16-beta.1",
          resolvedName: "@openclaw/codex",
          resolvedVersion: "2026.5.16-beta.1",
          resolvedSpec: "@openclaw/codex@2026.5.16-beta.1",
          integrity: "sha512-stale",
          shasum: "stale",
          installedAt: "2026-05-16T01:42:54.609Z",
          resolvedAt: "2026-05-16T01:42:52.981Z",
        },
      },
      { stateDir, candidates: [candidate] },
    );

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    const record = expectRecordFields(loaded.codex, {
      source: "npm",
      spec: "@openclaw/codex@2026.5.18-beta.1",
      installPath: codexDir,
      version: "2026.5.18-beta.1",
      resolvedName: "@openclaw/codex",
      resolvedVersion: "2026.5.18-beta.1",
      resolvedSpec: "@openclaw/codex@2026.5.18-beta.1",
    });
    expect(record.integrity).toBeUndefined();
    expect(record.shasum).toBeUndefined();
    expect(record.installedAt).toBeUndefined();
    expect(record.resolvedAt).toBeUndefined();

    const loadedSync = loadInstalledPluginIndexInstallRecordsSync({ stateDir });
    expectRecordFields(loadedSync.codex, {
      version: "2026.5.18-beta.1",
      resolvedVersion: "2026.5.18-beta.1",
    });
  });

  it("keeps recovered managed npm records cached until cache clear after package changes", () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const codexDir = writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/codex",
      pluginId: "codex",
      version: "2026.5.18-beta.1",
    });
    expectRecordFields(loadInstalledPluginIndexInstallRecordsSync({ stateDir }).codex, {
      source: "npm",
      spec: "@openclaw/codex@2026.5.18-beta.1",
      installPath: codexDir,
      version: "2026.5.18-beta.1",
    });

    const packagePath = path.join(codexDir, "package.json");
    const packageManifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as Record<
      string,
      unknown
    >;
    fs.writeFileSync(
      packagePath,
      JSON.stringify({
        ...packageManifest,
        version: "2026.5.19-beta.1",
      }),
      "utf8",
    );

    expectRecordFields(loadInstalledPluginIndexInstallRecordsSync({ stateDir }).codex, {
      source: "npm",
      spec: "@openclaw/codex@2026.5.18-beta.1",
      installPath: codexDir,
      version: "2026.5.18-beta.1",
      resolvedVersion: "2026.5.18-beta.1",
      resolvedSpec: "@openclaw/codex@2026.5.18-beta.1",
    });

    clearLoadInstalledPluginIndexInstallRecordsCache();

    expectRecordFields(loadInstalledPluginIndexInstallRecordsSync({ stateDir }).codex, {
      source: "npm",
      spec: "@openclaw/codex@2026.5.18-beta.1",
      installPath: codexDir,
      version: "2026.5.19-beta.1",
      resolvedVersion: "2026.5.19-beta.1",
      resolvedSpec: "@openclaw/codex@2026.5.19-beta.1",
    });
  });

  it("does not probe install record files again on hot cache hits", () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const candidate = createPluginCandidate(stateDir, "hot-cache");
    writePersistedInstalledPluginIndexInstallRecordsSync(
      {
        "hot-cache": {
          source: "npm",
          spec: "hot-cache@1.0.0",
        },
      },
      { stateDir, candidates: [candidate] },
    );
    expect(loadInstalledPluginIndexInstallRecordsSync({ stateDir })).toEqual({
      "hot-cache": {
        source: "npm",
        spec: "hot-cache@1.0.0",
      },
    });
    const statSpy = vi.spyOn(fs, "statSync");
    const readSpy = vi.spyOn(fs, "readFileSync");

    expect(loadInstalledPluginIndexInstallRecordsSync({ stateDir })).toEqual({
      "hot-cache": {
        source: "npm",
        spec: "hot-cache@1.0.0",
      },
    });

    expect(statSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("preserves git install resolution fields in persisted records", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const candidate = createPluginCandidate(stateDir, "git-demo");
    await writePersistedInstalledPluginIndexInstallRecords(
      {
        "git-demo": {
          source: "git",
          spec: "git:file:///tmp/git-demo@abc123",
          installPath: path.join(stateDir, "plugins", "git-demo"),
          gitUrl: "file:///tmp/git-demo",
          gitRef: "abc123",
          gitCommit: "abc123",
        },
      },
      { stateDir, candidates: [candidate] },
    );

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectRecordFields(loaded["git-demo"], {
      source: "git",
      spec: "git:file:///tmp/git-demo@abc123",
      gitUrl: "file:///tmp/git-demo",
      gitRef: "abc123",
      gitCommit: "abc123",
    });
  });

  it("preserves ClawHub ClawPack install metadata in persisted records", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");
    const candidate = createPluginCandidate(stateDir, "clawpack-demo");
    await writePersistedInstalledPluginIndexInstallRecords(
      {
        "clawpack-demo": {
          source: "clawhub",
          spec: "clawhub:clawpack-demo",
          installPath: path.join(stateDir, "plugins", "clawpack-demo"),
          clawhubUrl: "https://clawhub.ai",
          clawhubPackage: "clawpack-demo",
          clawhubFamily: "code-plugin",
          clawhubChannel: "official",
          artifactKind: "npm-pack",
          artifactFormat: "tgz",
          npmIntegrity: "sha512-clawpack",
          npmShasum: "1".repeat(40),
          npmTarballName: "clawpack-demo-2026.5.1-beta.2.tgz",
          clawpackSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          clawpackSpecVersion: 1,
          clawpackManifestSha256:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          clawpackSize: 4096,
          clawhubTrustDisposition: "review-required",
          clawhubTrustScanStatus: "suspicious",
          clawhubTrustReasons: ["payload_strings"],
          clawhubTrustPending: true,
          clawhubTrustCheckedAt: "2026-05-14T18:00:00.000Z",
          clawhubTrustAcknowledgedAt: "2026-05-14T18:00:03.000Z",
        },
      },
      { stateDir, candidates: [candidate] },
    );

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectRecordFields(loaded["clawpack-demo"], {
      source: "clawhub",
      spec: "clawhub:clawpack-demo",
      artifactKind: "npm-pack",
      artifactFormat: "tgz",
      npmIntegrity: "sha512-clawpack",
      npmShasum: "1".repeat(40),
      npmTarballName: "clawpack-demo-2026.5.1-beta.2.tgz",
      clawpackSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      clawpackSpecVersion: 1,
      clawpackManifestSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      clawpackSize: 4096,
      clawhubTrustDisposition: "review-required",
      clawhubTrustScanStatus: "suspicious",
      clawhubTrustReasons: ["payload_strings"],
      clawhubTrustPending: true,
      clawhubTrustCheckedAt: "2026-05-14T18:00:00.000Z",
      clawhubTrustAcknowledgedAt: "2026-05-14T18:00:03.000Z",
    });
  });

  it("returns an empty record map when no plugin index exists", () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");

    const records = loadInstalledPluginIndexInstallRecordsSync({ stateDir });
    expect(Object.keys(records)).toEqual([]);
    expect(Object.getPrototypeOf(records)).toBeNull();
  });

  it("updates and removes records without mutating caller state", () => {
    const records = createPluginInstallRecordMap<PluginInstallRecord>();
    const keep = { source: "npm" as const, spec: "keep@1.0.0" };
    const constructorRecord = { source: "path" as const };
    const toStringRecord = { source: "git" as const };
    const protoRecord = { source: "archive" as const };
    setPluginInstallRecordMapEntry(records, "keep", keep);
    setPluginInstallRecordMapEntry(records, "constructor", constructorRecord);
    setPluginInstallRecordMapEntry(records, "toString", toStringRecord);
    setPluginInstallRecordMapEntry(records, "__proto__", protoRecord);
    const withInstall = recordPluginInstallInRecords(records, {
      pluginId: "demo",
      source: "npm",
      spec: "demo@latest",
      installedAt: "2026-04-25T00:00:00.000Z",
    });

    expect(Object.getPrototypeOf(withInstall)).toBeNull();
    expect(Object.keys(records)).toEqual(["keep", "constructor", "toString", "__proto__"]);
    expectRecordFields(withInstall.demo, {
      source: "npm",
      spec: "demo@latest",
      installedAt: "2026-04-25T00:00:00.000Z",
    });
    expect(withInstall.keep).toBe(keep);
    expect(getPluginInstallRecordMapEntry(withInstall, "constructor")).toBe(constructorRecord);
    expect(getPluginInstallRecordMapEntry(withInstall, "toString")).toBe(toStringRecord);
    expect(getPluginInstallRecordMapEntry(withInstall, "__proto__")).toBe(protoRecord);
    const removed = removePluginInstallRecordFromRecords(withInstall, "demo");
    expect(removed).toEqual(records);
    expect(Object.getPrototypeOf(removed)).toBeNull();
    expect(removed.keep).toBe(keep);
    expect(getPluginInstallRecordMapEntry(removed, "constructor")).toBe(constructorRecord);
    expect(getPluginInstallRecordMapEntry(removed, "toString")).toBe(toStringRecord);
    expect(getPluginInstallRecordMapEntry(removed, "__proto__")).toBe(protoRecord);
    const withoutProto = removePluginInstallRecordFromRecords(removed, "__proto__");
    expect(Object.hasOwn(withoutProto, "__proto__")).toBe(false);
    expect(getPluginInstallRecordMapEntry(withoutProto, "constructor")).toBe(constructorRecord);
    expect(getPluginInstallRecordMapEntry(withoutProto, "toString")).toBe(toStringRecord);
  });

  it("strips transient install records from config writes", () => {
    expect(
      withoutPluginInstallRecords({
        plugins: {
          entries: {
            twitch: { enabled: true },
          },
          installs: {
            twitch: { source: "npm", spec: "twitch@1.0.0" },
          },
        },
      }),
    ).toEqual({
      plugins: {
        entries: {
          twitch: { enabled: true },
        },
      },
    });
  });

  it("preserves an authored empty plugins section while stripping transient install records", () => {
    expect(
      withoutPluginInstallRecords(
        {
          plugins: {
            installs: {
              twitch: { source: "npm", spec: "twitch@1.0.0" },
            },
          },
        },
        { preserveEmptyPlugins: true },
      ),
    ).toEqual({ plugins: {} });
  });

  it("returns empty records when the persisted plugin index is missing", async () => {
    const stateDir = tempDirs.make("openclaw-plugin-index-records-");

    await expect(readPersistedInstalledPluginIndexInstallRecords({ stateDir })).resolves.toBeNull();
    const records = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expect(Object.keys(records)).toEqual([]);
    expect(Object.getPrototypeOf(records)).toBeNull();
  });
});
