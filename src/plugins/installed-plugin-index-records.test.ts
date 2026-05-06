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

function writeManagedNpmPlugin(params: {
  stateDir: string;
  packageName: string;
  pluginId: string;
  version: string;
  dependencySpec?: string;
}): string {
  const npmRoot = path.join(params.stateDir, "npm");
  const rootManifestPath = path.join(npmRoot, "package.json");
  fs.mkdirSync(npmRoot, { recursive: true });
  const rootManifest = fs.existsSync(rootManifestPath)
    ? (JSON.parse(fs.readFileSync(rootManifestPath, "utf8")) as {
        dependencies?: Record<string, string>;
      })
    : {};
  fs.writeFileSync(
    rootManifestPath,
    JSON.stringify(
      {
        ...rootManifest,
        private: true,
        dependencies: {
          ...rootManifest.dependencies,
          [params.packageName]: params.dependencySpec ?? params.version,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const packageDir = path.join(npmRoot, "node_modules", params.packageName);
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: params.packageName,
      version: params.version,
      openclaw: { extensions: ["./dist/index.js"] },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(packageDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.pluginId,
      configSchema: { type: "object" },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(packageDir, "dist", "index.js"), "export {};\n", "utf8");
  return packageDir;
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
    expect(JSON.parse(fs.readFileSync(indexPath, "utf8"))).toMatchObject({
      version: 1,
      generatedAtMs: 1777118400000,
      installRecords: {
        twitch: {
          source: "npm",
          spec: "@openclaw/plugin-twitch@1.0.0",
          installPath: "plugins/npm/@openclaw/plugin-twitch",
        },
      },
      plugins: [
        {
          pluginId: "twitch",
          installRecordHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      ],
    });
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

    expect(
      JSON.parse(
        fs.readFileSync(resolveInstalledPluginIndexRecordsStorePath({ stateDir }), "utf8"),
      ),
    ).toMatchObject({
      installRecords: {
        missing: {
          source: "npm",
          spec: "missing-plugin@1.0.0",
          installPath: path.join(stateDir, "plugins", "missing"),
        },
      },
      plugins: [],
    });
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

    await expect(loadInstalledPluginIndexInstallRecords({ stateDir })).resolves.toMatchObject({
      codex: {
        source: "npm",
        spec: "@openclaw/codex@2026.5.2",
        installPath: codexDir,
        version: "2026.5.2",
        resolvedName: "@openclaw/codex",
        resolvedVersion: "2026.5.2",
        resolvedSpec: "@openclaw/codex@2026.5.2",
      },
      discord: {
        source: "npm",
        spec: "@openclaw/discord@2026.5.2",
        installPath: discordDir,
        version: "2026.5.2",
        resolvedName: "@openclaw/discord",
        resolvedVersion: "2026.5.2",
        resolvedSpec: "@openclaw/discord@2026.5.2",
      },
    });
    expect(loadInstalledPluginIndexInstallRecordsSync({ stateDir })).toMatchObject({
      codex: {
        source: "npm",
        installPath: codexDir,
      },
      discord: {
        source: "npm",
        installPath: discordDir,
      },
    });
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

    await expect(loadInstalledPluginIndexInstallRecords({ stateDir })).resolves.toMatchObject({
      discord: {
        source: "npm",
        spec: "@openclaw/discord@beta",
        installPath: path.join(stateDir, "custom", "discord"),
        integrity: "sha512-persisted",
      },
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

    await expect(loadInstalledPluginIndexInstallRecords({ stateDir })).resolves.toMatchObject({
      "git-demo": {
        source: "git",
        spec: "git:file:///tmp/git-demo@abc123",
        gitUrl: "file:///tmp/git-demo",
        gitRef: "abc123",
        gitCommit: "abc123",
      },
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

    await expect(loadInstalledPluginIndexInstallRecords({ stateDir })).resolves.toMatchObject({
      "clawpack-demo": {
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
      },
    });
  });

  it("returns an empty record map when no plugin index exists", () => {
    const stateDir = makeStateDir();

    expect(
      loadInstalledPluginIndexInstallRecordsSync({
        stateDir,
      }),
    ).toEqual({});
  });

  it("updates and removes records without mutating caller state", async () => {
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
    expect(withInstall.demo).toMatchObject({
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
    ).resolves.toEqual({});
  });
});
