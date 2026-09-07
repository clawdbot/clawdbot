import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { clearBundledDiscoveryModeMemo } from "./bundled-discovery-state.js";
import type { PluginCandidate } from "./discovery.js";
import { refreshPersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { isInstalledPluginEnabled, loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const PLUGIN_ID = "contract-provider";
const tempDirs: string[] = [];

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

function createFixture() {
  const stateDir = makeTrackedTempDir("openclaw-provider-compat-index", tempDirs);
  const pluginDir = path.join(stateDir, PLUGIN_ID);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "index.ts"),
    "throw new Error('runtime entry should not load while resolving plugin policy');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      enabledByDefault: true,
      configSchema: { type: "object" },
      contracts: { speechProviders: [PLUGIN_ID] },
    }),
    "utf8",
  );
  const candidate: PluginCandidate = {
    idHint: PLUGIN_ID,
    source: path.join(pluginDir, "index.ts"),
    rootDir: pluginDir,
    origin: "bundled",
  };
  const env = {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_VERSION: "2026.4.25",
    VITEST: "true",
  };
  return { candidate, env, stateDir };
}

function setMode(env: NodeJS.ProcessEnv, mode: "compat" | "allowlist") {
  writeConfigMachineState("plugins.bundledDiscovery", mode, { env });
  clearBundledDiscoveryModeMemo();
}

describe("bundled provider compatibility in installed plugin indexes", () => {
  it("passes the caller environment through manifest validation", () => {
    const { candidate, env } = createFixture();
    const index = loadInstalledPluginIndex({
      candidates: [
        {
          ...candidate,
          origin: "global",
          packageDir: candidate.rootDir,
          packageManifest: {
            install: {
              npmSpec: "@openclaw/contract-provider",
              minHostVersion: ">=2099.1.1",
            },
          },
        },
      ],
      env: { ...env, OPENCLAW_VERSION: "2099.1.1" },
    });

    expect(index.plugins.map((plugin) => plugin.pluginId)).toEqual([PLUGIN_ID]);
  });

  it("applies fresh and dynamic policy to a contract-only provider", () => {
    const { candidate, env } = createFixture();
    const config = { plugins: { allow: ["listed"] } };
    setMode(env, "compat");
    const index = loadInstalledPluginIndex({ candidates: [candidate], config, env });

    expect(index.plugins[0]?.enabled).toBe(true);
    expect(isInstalledPluginEnabled(index, PLUGIN_ID, config, env)).toBe(true);

    setMode(env, "allowlist");
    expect(isInstalledPluginEnabled(index, PLUGIN_ID, config, env)).toBe(false);

    setMode(env, "compat");
    expect(
      isInstalledPluginEnabled(
        index,
        PLUGIN_ID,
        { plugins: { ...config.plugins, deny: [PLUGIN_ID] } },
        env,
      ),
    ).toBe(false);
  });

  it("refreshes persisted contract-only provider policy without rebuilding source records", async () => {
    const { candidate, env, stateDir } = createFixture();
    const config = { plugins: { allow: ["listed"] } };
    setMode(env, "compat");
    const initial = await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      config,
      env,
    });
    expect(initial.plugins[0]?.enabled).toBe(true);

    setMode(env, "allowlist");
    const strict = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      config,
      env,
      policyPluginIds: [PLUGIN_ID],
    });
    expect(strict.plugins[0]?.enabled).toBe(false);

    setMode(env, "compat");
    const compatible = await refreshPersistedInstalledPluginIndex({
      reason: "policy-changed",
      stateDir,
      config,
      env,
      policyPluginIds: [PLUGIN_ID],
    });
    expect(compatible.plugins[0]?.enabled).toBe(true);
  });
});
