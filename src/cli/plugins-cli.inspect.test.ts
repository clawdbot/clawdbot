import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import {
  buildPluginDiagnosticsReportMock,
  buildPluginInspectReportMock,
  buildPluginSnapshotReportMock,
  pluginCliConfigMock,
  pluginsCliRuntimeLogs,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeErrors,
  setInstalledPluginIndexInstallRecords,
} from "./plugins-cli-test-helpers.js";

const workshopMocks = vi.hoisted(() => ({
  detectToolPolicyDiagnostic: vi.fn(),
}));

vi.mock("../skills/workshop/tool-policy-diagnostic.js", () => ({
  detectSkillWorkshopToolPolicyDiagnostic: workshopMocks.detectToolPolicyDiagnostic,
}));

describe("plugins cli inspect", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
    workshopMocks.detectToolPolicyDiagnostic.mockReset();
  });

  it("keeps inspect on the static snapshot and distinguishes disabled reasons from errors", async () => {
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
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [createPluginRecord({ id: "openclaw-mem0", name: "Mem0" })],
      diagnostics: [],
    });
    const inspectReport = {
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
      services: ["mem0-background"],
      gatewayDiscoveryServices: ["mem0-discovery", "mem0-discovery-secondary"],
      mcpServers: [
        { name: "local", hasStdioTransport: true },
        { name: "remote", hasStdioTransport: false },
        { name: "broken", hasStdioTransport: false, unsupported: true },
      ],
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
    };
    buildPluginInspectReportMock.mockReturnValue(inspectReport);

    await runPluginsCommand(["plugins", "inspect", "openclaw-mem0"]);

    expect(buildPluginDiagnosticsReportMock).not.toHaveBeenCalled();
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("Policy");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("allowConversationAccess: true");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("Services:\nmem0-background");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain(
      "Gateway discovery:\nmem0-discovery\nmem0-discovery-secondary",
    );
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("ClawHub package: openclaw-mem0");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("Artifact kind: npm-pack");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("Npm integrity: sha512-clawpack");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain(
      "ClawPack sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("ClawPack spec: 1");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("ClawPack size: 4096 bytes");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("remote");
    expect(pluginsCliRuntimeLogs.join("\n")).not.toContain("remote (unsupported transport)");
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("broken (unsupported transport)");

    await runPluginsCommand(["plugins", "inspect", "openclaw-mem0", "--json"]);
    expect(JSON.parse(pluginsCliRuntimeLogs.at(-1) ?? "null")).toMatchObject({
      services: ["mem0-background"],
      gatewayDiscoveryServices: ["mem0-discovery", "mem0-discovery-secondary"],
    });

    for (const { id, status, detail, label } of [
      {
        id: "workspace-disabled",
        status: "disabled" as const,
        detail: "workspace plugin (disabled by default)",
        label: "Reason",
      },
      { id: "broken", status: "error" as const, detail: "missing plugin module", label: "Error" },
    ]) {
      const plugin = createPluginRecord({
        id,
        enabled: status !== "disabled",
        status,
        error: detail,
        ...(status === "disabled" ? { activationReason: detail } : {}),
      });
      buildPluginSnapshotReportMock.mockReturnValue({ plugins: [plugin], diagnostics: [] });
      buildPluginInspectReportMock.mockReturnValue({ ...inspectReport, plugin });

      await runPluginsCommand(["plugins", "inspect", id]);

      const inspectOutput = pluginsCliRuntimeLogs.at(-1) ?? "";
      expect(inspectOutput).toContain(`Status: ${status}`);
      expect(inspectOutput).toContain(`${label}: ${detail}`);
      expect(inspectOutput).not.toContain(`${label === "Reason" ? "Error" : "Reason"}: ${detail}`);

      if (status === "disabled") {
        await runPluginsCommand(["plugins", "inspect", id, "--json"]);
        expect(JSON.parse(pluginsCliRuntimeLogs.at(-1) ?? "null").plugin).toMatchObject({
          status: "disabled",
          error: detail,
          activationReason: detail,
        });
      }
    }
  });

  it("runtime-inspects exact plugin ids and display names without repairing deps", async () => {
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [
        createPluginRecord({ id: "unrelated-plugin", name: "openclaw-mem0" }),
        createPluginRecord({ id: "openclaw-mem0", name: "Mem0" }),
      ],
      diagnostics: [],
    });
    buildPluginInspectReportMock.mockReturnValue({
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
      gatewayDiscoveryServices: ["mem0-runtime-discovery"],
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

    for (const selector of ["openclaw-mem0", "Mem0"]) {
      await runPluginsCommand(["plugins", "inspect", selector, "--runtime"]);
      expect(buildPluginDiagnosticsReportMock).toHaveBeenLastCalledWith({
        config: {},
        onlyPluginIds: ["openclaw-mem0"],
        runtimeInspection: true,
      });
      expect(pluginsCliRuntimeLogs.at(-1)).toContain("Gateway discovery:\nmem0-runtime-discovery");
    }
  });

  it("does not runtime-load plugins when inspect target is missing", async () => {
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    await expect(runPluginsCommand(["plugins", "inspect", "missing-plugin"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(buildPluginSnapshotReportMock).toHaveBeenCalledWith({ config: {} });
    expect(buildPluginDiagnosticsReportMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("Plugin not found: missing-plugin");
  });

  it.each([
    { label: "an implicit agent", agentIds: ["main"], entries: undefined },
    {
      label: "a multi-agent roster",
      agentIds: ["main", "venus"],
      entries: { main: {}, venus: {} },
    },
  ])("explains policy-hidden Skill Workshop for $label", async ({ agentIds, entries }) => {
    const config: OpenClawConfig = {
      tools: { profile: "messaging" },
      ...(entries ? { agents: { ownership: "explicit" as const, entries } } : {}),
    };
    pluginCliConfigMock.mockReturnValue(config);
    workshopMocks.detectToolPolicyDiagnostic.mockImplementation(
      ({ agentId }: { agentId: string }) => ({
        agentId,
        message:
          `Skill Workshop is active, but "skill_workshop" is hidden for agent "${agentId}": ` +
          'tools.profile: "messaging" does not include "skill_workshop". ' +
          'Add tools.alsoAllow: ["skill_workshop"].',
      }),
    );
    buildPluginSnapshotReportMock.mockReturnValue({ plugins: [], diagnostics: [] });

    await expect(runPluginsCommand(["plugins", "inspect", "skill-workshop"])).rejects.toThrow(
      "__exit__:1",
    );

    const output = runtimeErrors.at(-1);
    expect(output).toContain("Skill Workshop is built into OpenClaw, not a plugin");
    expect(output).toContain('tools.profile: "messaging" does not include "skill_workshop".');
    expect(output).toContain('Add tools.alsoAllow: ["skill_workshop"].');
    for (const agentId of agentIds) {
      expect(workshopMocks.detectToolPolicyDiagnostic).toHaveBeenCalledWith({
        config,
        workshopEnabled: true,
        agentId,
      });
      expect(output).toContain(`hidden for agent "${agentId}"`);
    }
  });
});
