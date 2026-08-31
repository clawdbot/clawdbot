// Covers gateway-startup plan activation under bundledDiscovery machine state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { clearBundledDiscoveryModeMemo } from "./bundled-discovery-state.js";
import { removeBundledDiscoveryStateRoot } from "./bundled-discovery.test-support.js";
import { resolveGatewayStartupPluginPlanFromRegistry } from "./channel-plugin-ids.js";
import type { InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginRegistrySnapshot } from "./plugin-registry-snapshot.js";

function buildStartupFixture() {
  const records: InstalledPluginIndexRecord[] = ["openai", "browser"].map((pluginId) => {
    const rootDir = `/tmp/plugins/${pluginId}`;
    return {
      pluginId,
      manifestPath: `${rootDir}/openclaw.plugin.json`,
      manifestHash: `${pluginId}-manifest`,
      rootDir,
      origin: "bundled",
      enabled: true,
      enabledByDefault: true,
      startup: {
        sidecar: true,
        memory: false,
        agentHarnesses: [],
        configPaths: [],
      },
      contributions: {
        channels: [],
        channelConfigs: [],
        providers: pluginId === "openai" ? ["openai"] : [],
        modelCatalogProviders: [],
        modelSupportPrefixes: [],
        modelSupportPatterns: [],
        autoEnableProviderIds: [],
        commandAliases: [],
        contracts: {},
      },
      compat: [],
    };
  });
  const index: PluginRegistrySnapshot = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 0,
    installRecords: {},
    plugins: records,
    diagnostics: [],
  };
  const manifestRegistry: PluginManifestRegistry = {
    plugins: ["openai", "browser"].map((id) => ({
      id,
      origin: "bundled",
      enabledByDefault: true,
      activation: { onStartup: true },
      providers: id === "openai" ? ["openai"] : [],
      channels: [],
      cliBackends: [],
      rootDir: `/tmp/plugins/${id}`,
      source: `/tmp/plugins/${id}/index.ts`,
      manifestPath: `/tmp/plugins/${id}/openclaw.plugin.json`,
      skills: [],
      hooks: [],
    })),
    diagnostics: [],
  };
  return { index, manifestRegistry };
}

describe("gateway startup plan under bundledDiscovery compat", () => {
  afterEach(() => {
    clearBundledDiscoveryModeMemo();
  });

  it("keeps provider owners while omitted non-providers remain strict", async () => {
    // Two-root regression (#123416): the plan's default-startup fallback must
    // read compat from the plan env, not the process root.
    const compatRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plan-compat-")),
    );
    const plainRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plan-plain-")),
    );
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    try {
      setTestEnvValue("OPENCLAW_STATE_DIR", compatRoot);
      writeConfigMachineState("plugins.bundledDiscovery", "compat");
      setTestEnvValue("OPENCLAW_STATE_DIR", plainRoot);
      clearBundledDiscoveryModeMemo();

      const { index, manifestRegistry } = buildStartupFixture();
      // Sanity: without an allowlist both default-enabled plugins can start.
      expect(
        resolveGatewayStartupPluginPlanFromRegistry({
          config: {},
          env: { ...process.env },
          index,
          manifestRegistry,
        }).pluginIds,
      ).toEqual(["openai", "browser"]);
      const config = {
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
        plugins: { allow: ["some-other-plugin"] },
      };
      const planEnv = { ...process.env, OPENCLAW_STATE_DIR: compatRoot };

      const compatPlan = resolveGatewayStartupPluginPlanFromRegistry({
        config,
        env: planEnv,
        index,
        manifestRegistry,
      }).pluginIds;
      expect(compatPlan).toContain("openai");
      expect(compatPlan).not.toContain("browser");
      // Process root has no recorded mode: strict allowlist gate stands.
      const strictPlan = resolveGatewayStartupPluginPlanFromRegistry({
        config,
        env: { ...process.env },
        index,
        manifestRegistry,
      }).pluginIds;
      expect(strictPlan).not.toContain("openai");
      expect(strictPlan).not.toContain("browser");
    } finally {
      envSnapshot.restore();
      clearBundledDiscoveryModeMemo();
      await removeBundledDiscoveryStateRoot(compatRoot);
      await removeBundledDiscoveryStateRoot(plainRoot);
    }
  });
});
