import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { PluginCandidate } from "./discovery.js";
import {
  loadInstalledPluginIndexInstallRecords,
  loadInstalledPluginIndexInstallRecordsSync,
  readPersistedInstalledPluginIndexInstallRecords,
  recordPluginInstallInRecords,
  removePluginInstallRecordFromRecords,
  resolveInstalledPluginIndexRecordsStorePath,
  withoutPluginInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "./installed-plugin-index-records.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs: string[] = [];

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-index-records-"));
  tempDirs.push(dir);
  return dir;
}

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
  return {
    idHint: pluginId,
    source,
    rootDir,
    origin: "global",
  };
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin index install records store", () => {
  it("writes machine-managed install records outside config", async () => {
    const stateDir = makeStateDir();
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
    expect(indexPath).toBe(path.join(stateDir, "plugins", "installs.json"));
    const persisted = JSON.parse(fs.readFileSync(indexPath, "utf8")) as {
      version?: number;
      generatedAtMs?: number;
      installRecords?: Record<string, unknown>;
      plugins?: Array<{ pluginId?: string; installRecordHash?: string }>;
    };
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
    const stateDir = makeStateDir();

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

    const persisted = JSON.parse(
      fs.readFileSync(resolveInstalledPluginIndexRecordsStorePath({ stateDir }), "utf8"),
    ) as { installRecords?: Record<string, unknown>; plugins?: unknown[] };
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
    const stateDir = makeStateDir();
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

  it("reads legacy persisted records when the plugin index has no plugin list", async () => {
    const stateDir = makeStateDir();
    const indexPath = resolveInstalledPluginIndexRecordsStorePath({ stateDir });
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(
      indexPath,
      JSON.stringify({
        installRecords: {
          legacy: {
            source: "npm",
            spec: "legacy@1.0.0",
            installPath: path.join(stateDir, "plugins", "legacy"),
          },
        },
      }),
      "utf8",
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
    const stateDir = makeStateDir();
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
    const indexPath = resolveInstalledPluginIndexRecordsStorePath({ stateDir });
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify({ installRecords: {}, plugins: [] }), "utf8");

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

  it("keeps persisted install record metadata over recovered npm records", async () => {
    const stateDir = makeStateDir();
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
          installPath: path.join(stateDir, "custom", "discord"),
          integrity: "sha512-persisted",
        },
      },
      { stateDir, candidates: [candidate] },
    );

    const loaded = await loadInstalledPluginIndexInstallRecords({ stateDir });
    expectRecordFields(loaded.discord, {
      source: "npm",
      spec: "@openclaw/discord@beta",
      installPath: path.join(stateDir, "custom", "discord"),
      integrity: "sha512-persisted",
    });
  });

  it("preserves git install resolution fields in persisted records", async () => {
    const stateDir = makeStateDir();
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
    const stateDir = makeStateDir();
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
    });
  });

  it("returns an empty record map when no plugin index exists", () => {
    const stateDir = makeStateDir();

    expect(
      loadInstalledPluginIndexInstallRecordsSync({
        stateDir,
      }),
    ).toStrictEqual({});
  });

  it("updates and removes records without mutating caller state", () => {
    const records: Record<string, PluginInstallRecord> = {
      keep: {
        source: "npm" as const,
        spec: "keep@1.0.0",
      },
    } satisfies Record<string, PluginInstallRecord>;
    const withInstall = recordPluginInstallInRecords(records, {
      pluginId: "demo",
      source: "npm",
      spec: "demo@latest",
      installedAt: "2026-04-25T00:00:00.000Z",
    });

    expect(records).toEqual({
      keep: {
        source: "npm",
        spec: "keep@1.0.0",
      },
    });
    expectRecordFields(withInstall.demo, {
      source: "npm",
      spec: "demo@latest",
      installedAt: "2026-04-25T00:00:00.000Z",
    });
    expect(removePluginInstallRecordFromRecords(withInstall, "demo")).toEqual(records);
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

  it("ignores invalid persisted plugin index files", async () => {
    const stateDir = makeStateDir();
    fs.mkdirSync(path.join(stateDir, "plugins"), { recursive: true });
    fs.writeFileSync(
      resolveInstalledPluginIndexRecordsStorePath({ stateDir }),
      JSON.stringify({ version: 999, records: {} }),
    );

    await expect(readPersistedInstalledPluginIndexInstallRecords({ stateDir })).resolves.toBeNull();
    await expect(
      loadInstalledPluginIndexInstallRecords({
        stateDir,
      }),
    ).resolves.toStrictEqual({});
  });
});
