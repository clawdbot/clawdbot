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
