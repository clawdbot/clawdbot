import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  clearCurrentPluginMetadataSnapshot,
  resolvePluginMetadataControlPlaneFingerprint,
  setCurrentPluginMetadataSnapshot,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { InstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { testing as setupRegistryRuntimeTesting } from "../plugins/setup-registry.runtime.js";
import { isCliProvider } from "./model-selection-cli.js";

function setCliBackendMetadataSnapshot(cliBackends: string[]) {
  const policyHash = resolveInstalledPluginIndexPolicyHash({});
  const index: InstalledPluginIndex = {
    version: 1,
    hostContractVersion: "test-host",
    compatRegistryVersion: "test-compat",
    migrationVersion: 1,
    policyHash,
    generatedAtMs: 0,
    installRecords: {},
    plugins: [
      {
        pluginId: "anthropic",
        manifestPath: "/tmp/anthropic/openclaw.plugin.json",
        manifestHash: "test-manifest",
        source: "/tmp/anthropic/index.ts",
        rootDir: "/tmp/anthropic",
        origin: "bundled",
        enabled: true,
        startup: {
          sidecar: false,
          memory: false,
          deferConfiguredChannelFullLoadUntilAfterListen: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
    diagnostics: [],
  };
  const snapshot = {
    policyHash,
    configFingerprint: resolvePluginMetadataControlPlaneFingerprint(
      {},
      {
        env: process.env,
        index,
        policyHash,
      },
    ),
    index,
    plugins: [
      {
        id: "anthropic",
        origin: "bundled",
        cliBackends,
      },
    ],
  } as unknown as PluginMetadataSnapshot;
  setCurrentPluginMetadataSnapshot(snapshot, { config: {}, env: process.env });
}

describe("isCliProvider", () => {
  beforeEach(() => {
    setupRegistryRuntimeTesting.resetRuntimeState();
    setCliBackendMetadataSnapshot(["claude-cli"]);
  });

  afterEach(() => {
    clearCurrentPluginMetadataSnapshot();
    setupRegistryRuntimeTesting.resetRuntimeState();
  });

  it("returns true for setup-registered cli backends", () => {
    expect(isCliProvider("claude-cli", {} as OpenClawConfig)).toBe(true);
  });

  it("accepts the anthropic-cli auth-choice id as a Claude CLI provider alias", () => {
    expect(isCliProvider("anthropic-cli", {} as OpenClawConfig)).toBe(true);
  });

  it("returns false for provider ids", () => {
    expect(isCliProvider("example-cli", {} as OpenClawConfig)).toBe(false);
  });

  it("does not execute setup runtime when descriptor metadata has no matching backend", () => {
    setupRegistryRuntimeTesting.setRuntimeModuleForTest({
      resolvePluginSetupCliBackend: () => {
        throw new Error("setup runtime should not load for CLI provider checks");
      },
    });

    expect(isCliProvider("openai", {} as OpenClawConfig)).toBe(false);
  });
});
