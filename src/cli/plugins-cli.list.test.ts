import { beforeEach, describe, expect, it } from "vitest";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  buildPluginDiagnosticsReport,
  buildPluginInspectReport,
  buildPluginRegistrySnapshotReport,
  buildPluginSnapshotReport,
  inspectPluginRegistry,
  resetPluginsCliTestState,
  refreshPluginRegistry,
  runPluginsCommand,
  runtimeErrors,
  runtimeLogs,
  setInstalledPluginIndexInstallRecords,
} from "./plugins-cli-test-helpers.js";

describe("plugins cli list", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  it("includes imported state in JSON output", async () => {
    buildPluginRegistrySnapshotReport.mockReturnValue({
      workspaceDir: "/workspace",
      registrySource: "persisted",
      registryDiagnostics: [],
      plugins: [
        createPluginRecord({
          id: "demo",
          imported: true,
          activated: true,
          explicitlyEnabled: true,
        }),
      ],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "list", "--json"]);

    expect(buildPluginRegistrySnapshotReport).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {},
        logger: expect.objectContaining({
          info: expect.any(Function),
          warn: expect.any(Function),
          error: expect.any(Function),
        }),
      }),
    );

    expect(JSON.parse(runtimeLogs[0] ?? "null")).toEqual({
      workspaceDir: "/workspace",
      registry: {
        source: "persisted",
        diagnostics: [],
      },
      plugins: [
        expect.objectContaining({
          id: "demo",
          imported: true,
          activated: true,
          explicitlyEnabled: true,
        }),
      ],
      diagnostics: [],
    });
  });

  it("keeps doctor on a module-loading snapshot", async () => {
    buildPluginDiagnosticsReport.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "doctor"]);

    expect(buildPluginDiagnosticsReport).toHaveBeenCalledWith({ effectiveOnly: true });
    expect(runtimeLogs).toContain("No plugin issues detected.");
  });

  it("reports persisted plugin registry state without refreshing", async () => {
    inspectPluginRegistry.mockResolvedValue({
      state: "stale",
      refreshReasons: ["stale-manifest"],
      persisted: {
        plugins: [{ pluginId: "demo", enabled: true }],
      },
      current: {
        plugins: [
          { pluginId: "demo", enabled: true },
          { pluginId: "next", enabled: false },
        ],
      },
    });

    await runPluginsCommand(["plugins", "registry"]);

    expect(inspectPluginRegistry).toHaveBeenCalledWith({ config: {} });
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expect(runtimeLogs.join("\n")).toContain("State:");
    expect(runtimeLogs.join("\n")).toContain("stale");
    expect(runtimeLogs.join("\n")).toContain("Refresh reasons:");
    expect(runtimeLogs.join("\n")).toContain("openclaw plugins registry --refresh");
  });

  it("refreshes the persisted plugin registry on request", async () => {
    refreshPluginRegistry.mockResolvedValue({
      plugins: [
        { pluginId: "demo", enabled: true },
        { pluginId: "off", enabled: false },
      ],
    });

    await runPluginsCommand(["plugins", "registry", "--refresh"]);

    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: {},
      reason: "manual",
    });
    expect(inspectPluginRegistry).not.toHaveBeenCalled();
    expect(runtimeLogs.join("\n")).toContain("Plugin registry refreshed: 1/2 enabled");
  });

  it("keeps inspect on the static snapshot by default", async () => {
    setInstalledPluginIndexInstallRecords({
      "openclaw-mem0": {
        source: "clawhub",
        spec: "clawhub:openclaw-mem0",
        installPath: "/plugins/openclaw-mem0",
        version: "2026.5.1",
        clawhubPackage: "openclaw-mem0",
        clawhubChannel: "official",
        artifactKind: "npm-pack",
        artifactFormat: "tgz",
        npmIntegrity: "sha512-clawpack",
        npmShasum: "1".repeat(40),
        npmTarballName: "openclaw-mem0-2026.5.1.tgz",
        clawpackSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        clawpackSpecVersion: 1,
        clawpackManifestSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        clawpackSize: 4096,
      },
    });
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [createPluginRecord({ id: "openclaw-mem0", name: "Mem0" })],
      diagnostics: [],
    });
    buildPluginInspectReport.mockReturnValue({
      workspaceDir: "/workspace",
      plugin: createPluginRecord({ id: "openclaw-mem0", name: "Mem0" }),
      shape: "hook-only",
      capabilityMode: "plain",
      capabilityCount: 1,
      capabilities: [],
      typedHooks: [{ name: "agent_end" }],
      customHooks: [],
      tools: [],
      commands: [],
      cliCommands: [],
      services: [],
      gatewayDiscoveryServices: [],
      gatewayMethods: [],
      mcpServers: [],
      lspServers: [],
      httpRouteCount: 0,
      bundleCapabilities: [],
      diagnostics: [],
      policy: {
        allowConversationAccess: true,
        allowedModels: [],
        hasAllowedModelsConfig: false,
      },
      usesLegacyBeforeAgentStart: false,
      compatibility: [],
    });

    await runPluginsCommand(["plugins", "inspect", "openclaw-mem0"]);

    expect(buildPluginDiagnosticsReport).not.toHaveBeenCalled();
    expect(runtimeLogs.join("\n")).toContain("Policy");
    expect(runtimeLogs.join("\n")).toContain("allowConversationAccess: true");
    expect(runtimeLogs.join("\n")).toContain("ClawHub package: openclaw-mem0");
    expect(runtimeLogs.join("\n")).toContain("Artifact kind: npm-pack");
    expect(runtimeLogs.join("\n")).toContain("Npm integrity: sha512-clawpack");
    expect(runtimeLogs.join("\n")).toContain(
      "ClawPack sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(runtimeLogs.join("\n")).toContain("ClawPack spec: 1");
    expect(runtimeLogs.join("\n")).toContain("ClawPack size: 4096 bytes");
  });

  it("runtime-inspects without repairing deps", async () => {
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [createPluginRecord({ id: "openclaw-mem0", name: "Mem0" })],
      diagnostics: [],
    });
    buildPluginInspectReport.mockReturnValue({
      workspaceDir: "/workspace",
      plugin: createPluginRecord({ id: "openclaw-mem0", name: "Mem0" }),
      shape: "hook-only",
      capabilityMode: "plain",
      capabilityCount: 1,
      capabilities: [],
      typedHooks: [],
      customHooks: [],
      tools: [],
      commands: [],
      cliCommands: [],
      services: [],
      gatewayDiscoveryServices: [],
      gatewayMethods: [],
      mcpServers: [],
      lspServers: [],
      httpRouteCount: 0,
      bundleCapabilities: [],
      diagnostics: [],
      policy: {
        allowedModels: [],
        hasAllowedModelsConfig: false,
      },
      usesLegacyBeforeAgentStart: false,
      compatibility: [],
    });

    await runPluginsCommand(["plugins", "inspect", "openclaw-mem0", "--runtime"]);

    expect(buildPluginDiagnosticsReport).toHaveBeenCalledWith({
      config: {},
      onlyPluginIds: ["openclaw-mem0"],
    });
  });

  it("does not runtime-load plugins when inspect target is missing", async () => {
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    await expect(runPluginsCommand(["plugins", "inspect", "missing-plugin"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(buildPluginSnapshotReport).toHaveBeenCalledWith({ config: {} });
    expect(buildPluginDiagnosticsReport).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("Plugin not found: missing-plugin");
  });
});
