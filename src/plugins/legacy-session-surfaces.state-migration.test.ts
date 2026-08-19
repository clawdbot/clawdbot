import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  autoMigrateLegacyState,
  resetAutoMigrateLegacyStateForTest,
} from "../infra/state-migrations.doctor.js";
import { resetAutoMigrateLegacyStateDirForTest } from "../infra/state-migrations.state-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { writePersistedInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-records.js";
import { prepareLegacySessionSurfaces } from "./legacy-session-surfaces.js";
import { clearPluginRegistryLoadCache } from "./loader.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs: string[] = [];

afterEach(() => {
  clearPluginRegistryLoadCache();
  clearPluginMetadataLifecycleCaches();
  resetAutoMigrateLegacyStateForTest();
  resetAutoMigrateLegacyStateDirForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

function writeSessionSurfacePlugin(params: {
  stateDir: string;
  rootDir: string;
  pluginId: string;
  channelId: string;
}) {
  const packageName = `@fixture/${params.pluginId}`;
  const pluginDir = writeManagedNpmPlugin({
    stateDir: params.stateDir,
    packageName,
    pluginId: params.pluginId,
    version: "1.0.0",
  });
  const marker = (name: string) => path.join(params.rootDir, `${params.pluginId}-${name}.marker`);
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: packageName,
      version: "1.0.0",
      type: "module",
      openclaw: {
        extensions: ["./dist/index.js"],
        setupEntry: "./dist/setup-entry.js",
        setupFeatures: { legacySessionSurfaces: true },
        channel: { id: params.channelId },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.pluginId,
      channels: [params.channelId],
      configSchema: { type: "object" },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "dist", "index.js"),
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(marker("full"))}, "loaded\\n");
export default { register() {} };
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "dist", "setup-plugin.js"),
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(marker("setup-plugin"))}, "loaded\\n");
export const setupPlugin = { id: ${JSON.stringify(params.channelId)} };
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "dist", "legacy-session-surface.js"),
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(marker("sidecar"))}, "loaded\\n");
export const legacySessionSurface = {
  isLegacyGroupSessionKey(key) { return key.startsWith("fixture-group:"); },
  canonicalizeLegacySessionKey({ key, agentId }) {
    return key.startsWith("fixture-group:")
      ? \`agent:\${agentId}:${params.channelId}:group:\${key.slice("fixture-group:".length).toLowerCase()}\`
      : null;
  },
};
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "dist", "setup-entry.js"),
    `import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";
export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  features: { legacySessionSurfaces: true },
  plugin: { specifier: "./setup-plugin.js", exportName: "setupPlugin" },
  legacySessionSurface: {
    specifier: "./legacy-session-surface.js",
    exportName: "legacySessionSurface",
  },
});
`,
    "utf8",
  );
  return { pluginDir, marker };
}

describe("installed channel legacy session surfaces", () => {
  it("loads only the selected setup sidecar and canonicalizes its legacy group key", async () => {
    const rootDir = makeTrackedTempDir("openclaw-session-surface", tempDirs);
    const stateDir = path.join(rootDir, "state");
    const bundledDir = path.join(rootDir, "bundled-disabled");
    fs.mkdirSync(bundledDir, { recursive: true });
    const selected = writeSessionSurfacePlugin({
      stateDir,
      rootDir,
      pluginId: "fixture-session-owner",
      channelId: "fixture-chat",
    });
    const blocked = writeSessionSurfacePlugin({
      stateDir,
      rootDir,
      pluginId: "blocked-session-owner",
      channelId: "blocked-chat",
    });
    const env = {
      HOME: rootDir,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_VERSION: "2026.8.1",
      VITEST: "true",
    } as NodeJS.ProcessEnv;
    const config = {
      channels: {
        "fixture-chat": { enabled: true },
        "blocked-chat": { enabled: true },
      },
      plugins: {
        allow: ["fixture-session-owner", "blocked-session-owner"],
        entries: {
          "fixture-session-owner": { enabled: true },
          "blocked-session-owner": { enabled: false },
        },
      },
    } as OpenClawConfig;

    writePersistedInstalledPluginIndexInstallRecordsSync(
      {
        "fixture-session-owner": {
          source: "npm",
          spec: "@fixture/fixture-session-owner@1.0.0",
          installPath: selected.pluginDir,
        },
        "blocked-session-owner": {
          source: "npm",
          spec: "@fixture/blocked-session-owner@1.0.0",
          installPath: blocked.pluginDir,
        },
      },
      { stateDir, env, config },
    );
    clearPluginMetadataLifecycleCaches();
    const persisted = loadPluginMetadataSnapshot({
      config,
      env,
      stateDir,
    });
    const selectedRecord = persisted.manifestRegistry.plugins.find(
      (record) => record.id === "fixture-session-owner",
    );
    expect(persisted.registrySource).toBe("persisted");
    expect(persisted.index.installRecords["fixture-session-owner"]).toMatchObject({
      source: "npm",
      installPath: selected.pluginDir,
    });
    expect(selectedRecord).toMatchObject({
      origin: "global",
      channels: ["fixture-chat"],
      setupSource: fs.realpathSync(path.join(selected.pluginDir, "dist", "setup-entry.js")),
      packageManifest: { setupFeatures: { legacySessionSurfaces: true } },
    });
    const prepared = prepareLegacySessionSurfaces({ config, env });
    expect(prepared.failures).toEqual([]);
    expect(prepared.surfaces).toHaveLength(1);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.surfaces)).toBe(true);
    expect(Object.isFrozen(prepared.failures)).toBe(true);
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "fixture-group:Legacy-Room": { sessionId: "legacy-group", updatedAt: 1 },
      }),
      "utf8",
    );

    const result = await autoMigrateLegacyState({ cfg: config, env, homedir: () => rootDir });
    const migrated = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, unknown>;

    expect(result.warnings).toEqual([]);
    expect(migrated["fixture-group:Legacy-Room"]).toBeUndefined();
    expect(Object.keys(migrated)).toEqual(["agent:main:fixture-chat:group:legacy-room"]);
    expect(migrated["agent:main:fixture-chat:group:legacy-room"]).toMatchObject({
      sessionId: "legacy-group",
    });
    expect(fs.existsSync(selected.marker("sidecar"))).toBe(true);
    expect(fs.existsSync(selected.marker("setup-plugin"))).toBe(false);
    expect(fs.existsSync(selected.marker("full"))).toBe(false);
    expect(fs.existsSync(blocked.marker("sidecar"))).toBe(false);
    expect(fs.existsSync(blocked.marker("setup-plugin"))).toBe(false);
    expect(fs.existsSync(blocked.marker("full"))).toBe(false);
  });

  it("loads an explicitly enabled owner without a channel presence signal", async () => {
    const rootDir = makeTrackedTempDir("openclaw-session-surface-enabled-only", tempDirs);
    const stateDir = path.join(rootDir, "state");
    const bundledDir = path.join(rootDir, "bundled-disabled");
    fs.mkdirSync(bundledDir, { recursive: true });
    const fixture = writeSessionSurfacePlugin({
      stateDir,
      rootDir,
      pluginId: "enabled-only-session-owner",
      channelId: "enabled-only-chat",
    });
    const env = {
      HOME: rootDir,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_VERSION: "2026.8.1",
      VITEST: "true",
    } as NodeJS.ProcessEnv;
    const config = {
      plugins: {
        allow: ["enabled-only-session-owner"],
        entries: { "enabled-only-session-owner": { enabled: true } },
      },
    } as OpenClawConfig;
    writePersistedInstalledPluginIndexInstallRecordsSync(
      {
        "enabled-only-session-owner": {
          source: "npm",
          spec: "@fixture/enabled-only-session-owner@1.0.0",
          installPath: fixture.pluginDir,
        },
      },
      { stateDir, env, config },
    );
    clearPluginMetadataLifecycleCaches();
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "fixture-group:Enabled-Only": { sessionId: "enabled-only-group", updatedAt: 1 },
      }),
      "utf8",
    );

    const result = await autoMigrateLegacyState({ cfg: config, env, homedir: () => rootDir });
    const migrated = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, unknown>;

    expect(result.warnings).toEqual([]);
    expect(migrated["fixture-group:Enabled-Only"]).toBeUndefined();
    expect(migrated["agent:main:enabled-only-chat:group:enabled-only"]).toMatchObject({
      sessionId: "enabled-only-group",
    });
    expect(fs.existsSync(fixture.marker("sidecar"))).toBe(true);
    expect(fs.existsSync(fixture.marker("setup-plugin"))).toBe(false);
    expect(fs.existsSync(fixture.marker("full"))).toBe(false);
  });

  it("defers reinterpretation when a selected owner's sidecar has no canonicalizer", async () => {
    const rootDir = makeTrackedTempDir("openclaw-session-surface-failure", tempDirs);
    const stateDir = path.join(rootDir, "state");
    const bundledDir = path.join(rootDir, "bundled-disabled");
    fs.mkdirSync(bundledDir, { recursive: true });
    const fixture = writeSessionSurfacePlugin({
      stateDir,
      rootDir,
      pluginId: "broken-session-owner",
      channelId: "broken-chat",
    });
    fs.writeFileSync(
      path.join(fixture.pluginDir, "dist", "legacy-session-surface.js"),
      `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(fixture.marker("sidecar"))}, "loaded\\n");
export const legacySessionSurface = {
  isLegacyGroupSessionKey(key) { return key.startsWith("fixture-group:"); },
};
`,
      "utf8",
    );
    const env = {
      HOME: rootDir,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_VERSION: "2026.8.1",
      VITEST: "true",
    } as NodeJS.ProcessEnv;
    const config = {
      channels: { "broken-chat": { enabled: true } },
      plugins: {
        allow: ["broken-session-owner"],
        entries: { "broken-session-owner": { enabled: true } },
      },
    } as OpenClawConfig;
    writePersistedInstalledPluginIndexInstallRecordsSync(
      {
        "broken-session-owner": {
          source: "npm",
          spec: "@fixture/broken-session-owner@1.0.0",
          installPath: fixture.pluginDir,
        },
      },
      { stateDir, env, config },
    );
    clearPluginMetadataLifecycleCaches();
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "fixture-group:Keep-Raw": { sessionId: "deferred-group", updatedAt: 1 },
      }),
      "utf8",
    );

    const result = await autoMigrateLegacyState({ cfg: config, env, homedir: () => rootDir });
    const preserved = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, unknown>;

    expect(result.warnings).toContainEqual(
      expect.stringContaining(
        'Deferred legacy session-key migration for channel owner "broken-session-owner"',
      ),
    );
    expect(result.warnings).toContainEqual(
      expect.stringContaining("must declare canonicalizeLegacySessionKey"),
    );
    expect(result.warnings).toHaveLength(1);
    expect(preserved["fixture-group:Keep-Raw"]).toMatchObject({
      sessionId: "deferred-group",
    });
    expect(preserved["agent:main:fixture-group:keep-raw"]).toBeUndefined();
    expect(fs.existsSync(fixture.marker("sidecar"))).toBe(true);
    expect(fs.existsSync(fixture.marker("full"))).toBe(false);
  });
});
