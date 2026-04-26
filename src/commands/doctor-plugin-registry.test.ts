import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginCandidate } from "../plugins/discovery.js";
import {
  readPersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndex,
} from "../plugins/installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import { note } from "../terminal/note.js";
import { maybeRepairPluginRegistryState } from "./doctor-plugin-registry.js";
import { DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV } from "./doctor/shared/plugin-registry-migration.js";

vi.mock("../terminal/note.js", () => ({
  note: vi.fn(),
}));

const tempDirs: string[] = [];

afterEach(() => {
  vi.mocked(note).mockReset();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-doctor-plugin-registry", tempDirs);
}

function hermeticEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
    OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: "1",
    OPENCLAW_VERSION: "2026.4.25",
    VITEST: "true",
    ...overrides,
  };
}

function createCandidate(rootDir: string, id = "demo"): PluginCandidate {
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load during doctor registry repair');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      name: id,
      configSchema: { type: "object" },
      providers: [id],
    }),
    "utf8",
  );
  return {
    idHint: id,
    source: path.join(rootDir, "index.ts"),
    rootDir,
    origin: "global",
  };
}

function createCurrentIndex(): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    installRecords: {},
    plugins: [],
    diagnostics: [],
  };
}

describe("maybeRepairPluginRegistryState", () => {
  it("refreshes an existing registry during repair", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    await writePersistedInstalledPluginIndex(createCurrentIndex(), { stateDir });

    const nextConfig = await maybeRepairPluginRegistryState({
      stateDir,
      candidates: [createCandidate(pluginDir)],
      env: hermeticEnv(),
      config: {},
      prompter: { shouldRepair: true },
    });

    expect(nextConfig).toEqual({});
    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toMatchObject({
      refreshReason: "migration",
      plugins: [
        expect.objectContaining({
          pluginId: "demo",
        }),
      ],
    });
  });

  it("does not repair when registry migration is disabled", async () => {
    const stateDir = makeTempDir();

    const nextConfig = await maybeRepairPluginRegistryState({
      stateDir,
      env: hermeticEnv({
        [DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV]: "1",
      }),
      config: {},
      prompter: { shouldRepair: true },
    });

    expect(nextConfig).toEqual({});
    expect(vi.mocked(note).mock.calls.join("\n")).toContain(DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV);
  });
});
