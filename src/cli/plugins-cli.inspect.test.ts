import { stripVTControlCharacters } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { recordInstalledPluginIndexInstallOwner } from "../plugins/installed-plugin-index-install-owner.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginInspectReport } from "../plugins/status.js";
import {
  createInstalledPluginIndexSnapshot,
  createPluginRecord,
} from "../plugins/status.test-fixtures.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  withPluginDiagnosticsReportForInspectionMock,
  buildAllPluginInspectReportsMock,
  buildPluginDiagnosticsReportMock,
  buildPluginInspectReportMock,
  buildPluginRegistrySnapshotReportMock,
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
  loadMetadata: vi.fn(),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: workshopMocks.loadMetadata,
}));

vi.mock("../skills/workshop/tool-policy-diagnostic.js", () => ({
  detectSkillWorkshopToolPolicyDiagnostic: workshopMocks.detectToolPolicyDiagnostic,
}));

function setInspectInstallRecords(
  records: Record<string, PluginInstallRecord>,
  plugins = Object.entries(records).map(([pluginId, install]) =>
    recordInstalledPluginIndexInstallOwner({ pluginId, rootDir: install.installPath }, pluginId),
  ),
) {
  setInstalledPluginIndexInstallRecords(records);
  const metadata = {
    index: { ...createInstalledPluginIndexSnapshot(plugins), installRecords: records },
  };
  workshopMocks.loadMetadata.mockReturnValue(metadata);
  return metadata;
}

function createInspectReport(
  overrides: Partial<PluginInspectReport> & Pick<PluginInspectReport, "plugin">,
): PluginInspectReport {
  return {
    workspaceDir: "/workspace",
    shape: "non-capability",
    capabilityMode: "none",
    capabilityCount: 0,
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
    policy: { allowedModels: [], hasAllowedModelsConfig: false },
    compatibility: [],
    ...overrides,
  };
}

type PluginHumanFormat = "detail" | "table" | "verbose";

function readRenderedStatus(output: string, format: PluginHumanFormat): string | undefined {
  const text = stripVTControlCharacters(output);
  if (format === "detail") {
    return /^Status: (.+)$/m.exec(text)?.[1];
  }
  if (format === "verbose") {
    return /^Display \(display-probe\) (.+)$/m.exec(text)?.[1];
  }
  const lines = text.split("\n");
  const cells = (line: string) =>
    line
      .split(/[│|]/u)
      .slice(1, -1)
      .map((cell) => cell.trim());
  const header = lines.find((line) => line.includes("Name") && line.includes("Status"));
  const row = lines.find((line) => line.includes("Display"));
  return header && row ? cells(row)[cells(header).indexOf("Status")] : undefined;
}

describe("plugins cli inspect", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
    workshopMocks.detectToolPolicyDiagnostic.mockReset();
    workshopMocks.loadMetadata.mockReset();
    workshopMocks.loadMetadata.mockReturnValue({ index: createInstalledPluginIndexSnapshot([]) });
  });

  it.each([false, true])(
    "serializes while owned and waits for release before JSON output (all: %s)",
    async (all) => {
      const started = createDeferredCore();
      const finish = createDeferredCore();
      const plugin = createPluginRecord({ id: "owned-inspect" });
      let released = false;
      let serialized = false;
      Object.defineProperty(plugin, "description", {
        enumerable: true,
        get() {
          expect(released).toBe(false);
          serialized = true;
          return "resource-backed description";
        },
      });
      const report = {
        ...createEmptyPluginRegistry(),
        workspaceScope: "omitted" as const,
        plugins: [plugin],
      };
      buildPluginSnapshotReportMock.mockReturnValue(report);
      const inspect = createInspectReport({ plugin });
      buildPluginInspectReportMock.mockReturnValue(inspect);
      buildAllPluginInspectReportsMock.mockReturnValue([inspect]);
      withPluginDiagnosticsReportForInspectionMock.mockImplementation(
        async (_params, formatReport) => {
          const output = formatReport(report);
          expect(serialized).toBe(true);
          started.resolve();
          await finish.promise;
          released = true;
          return output;
        },
      );
      const command = runPluginsCommand([
        "plugins",
        "inspect",
        all ? "--all" : plugin.id,
        "--runtime",
        "--json",
      ]);
      try {
        await started.promise;
        expect(pluginsCliRuntimeLogs).toEqual([]);
      } finally {
        finish.resolve();
        await command;
      }
      expect(withPluginDiagnosticsReportForInspectionMock).toHaveBeenCalledTimes(1);
      expect(released).toBe(true);
      expect(pluginsCliRuntimeLogs).toHaveLength(1);
      const result = JSON.parse(pluginsCliRuntimeLogs[0] ?? "");
      expect((all ? result[0] : result).plugin.description).toBe("resource-backed description");
    },
  );

  it.each(["serialization", "disposal", "missing-report"] as const)(
    "does not emit success when inspection has a %s failure",
    async (failure) => {
      const plugin = createPluginRecord({ id: "owned-inspect" });
      const report = {
        ...createEmptyPluginRegistry(),
        workspaceScope: "omitted" as const,
        plugins: [plugin],
      };
      buildPluginSnapshotReportMock.mockReturnValue(report);
      const inspect = createInspectReport({ plugin });
      buildPluginInspectReportMock.mockReturnValue(failure === "missing-report" ? null : inspect);
      const serializationError = new Error("fixture serialization failed");
      const disposalError = new Error("fixture disposal failed");
      if (failure.startsWith("serialization")) {
        Object.defineProperty(plugin, "description", {
          enumerable: true,
          get() {
            throw serializationError;
          },
        });
      }
      withPluginDiagnosticsReportForInspectionMock.mockImplementation(
        async (_params, formatReport) => {
          const output = formatReport(report);
          expect(pluginsCliRuntimeLogs).toEqual([]);
          if (failure === "disposal") {
            throw disposalError;
          }
          return output;
        },
      );
      const command = runPluginsCommand(["plugins", "inspect", plugin.id, "--runtime", "--json"]);
      await expect(command).rejects.toThrow(
        failure === "missing-report" ? "__exit__:1" : `fixture ${failure} failed`,
      );
      expect(withPluginDiagnosticsReportForInspectionMock).toHaveBeenCalledTimes(1);
      expect(pluginsCliRuntimeLogs).toHaveLength(failure === "missing-report" ? 1 : 0);
    },
  );

  it.each([{ selection: ["--all", "extra"] }, { selection: [] }])(
    "rejects invalid runtime selection before acquisition: $selection",
    async ({ selection }) => {
      await expect(
        runPluginsCommand(["plugins", "inspect", ...selection, "--runtime", "--json"]),
      ).rejects.toThrow("__exit__:1");
      expect(withPluginDiagnosticsReportForInspectionMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { enabled: true, status: "loaded", expected: "enabled" },
    { enabled: false, status: "disabled", expected: "disabled" },
    { enabled: true, status: "error", expected: "error" },
  ] as const)(
    "renders cold $status records consistently across human commands",
    async (testCase) => {
      const plugin = createPluginRecord({
        id: "display-probe",
        name: "Display",
        enabled: testCase.enabled,
        status: testCase.status,
        imported: false,
      });
      const report = { plugins: [plugin], diagnostics: [] };
      const inspect = createInspectReport({ plugin });
      buildPluginSnapshotReportMock.mockReturnValue(report);
      buildPluginInspectReportMock.mockReturnValue(inspect);
      buildAllPluginInspectReportsMock.mockReturnValue([inspect]);
      buildPluginRegistrySnapshotReportMock.mockReturnValue({
        ...report,
        workspaceDir: "/workspace",
        registrySource: "persisted",
        registryDiagnostics: [],
      });

      const commands: Array<{ args: string[]; format: PluginHumanFormat }> = [
        { args: ["list"], format: "table" },
        { args: ["list", "--verbose"], format: "verbose" },
        { args: ["inspect", plugin.id], format: "detail" },
        { args: ["info", plugin.id], format: "detail" },
        { args: ["inspect", "--all"], format: "table" },
      ];
      const renderedStatuses: Array<[string, string | undefined]> = [];
      for (const { args, format } of commands) {
        pluginsCliRuntimeLogs.length = 0;
        await runPluginsCommand(["plugins", ...args]);
        renderedStatuses.push([
          args.join(" "),
          readRenderedStatus(pluginsCliRuntimeLogs.join("\n"), format),
        ]);
      }
      expect(buildPluginDiagnosticsReportMock).not.toHaveBeenCalled();
      expect(withPluginDiagnosticsReportForInspectionMock).not.toHaveBeenCalled();

      for (const selection of [[plugin.id], ["--all"]]) {
        pluginsCliRuntimeLogs.length = 0;
        await runPluginsCommand(["plugins", "inspect", ...selection, "--json"]);
        const json = JSON.parse(pluginsCliRuntimeLogs.at(-1) ?? "null");
        const entry = Array.isArray(json) ? json[0] : json;
        expect(entry.plugin).toMatchObject({
          enabled: testCase.enabled,
          status: testCase.status,
          imported: false,
        });
      }
      expect(renderedStatuses).toEqual(
        commands.map(({ args }) => [args.join(" "), testCase.expected]),
      );
    },
  );

  it.each([
    { args: ["inspect", "display-probe", "--runtime"], format: "detail" },
    { args: ["inspect", "--all", "--runtime"], format: "table" },
  ] as const)("retains actual runtime status for $format output", async ({ args, format }) => {
    const plugin = createPluginRecord({ id: "display-probe", name: "Display", imported: true });
    const report = { plugins: [plugin], diagnostics: [] };
    const inspect = createInspectReport({ plugin });
    buildPluginSnapshotReportMock.mockReturnValue(report);
    withPluginDiagnosticsReportForInspectionMock.mockImplementation(async (_params, formatReport) =>
      formatReport({ ...createEmptyPluginRegistry(), workspaceScope: "omitted", ...report }),
    );
    buildPluginInspectReportMock.mockReturnValue(inspect);
    buildAllPluginInspectReportsMock.mockReturnValue([inspect]);

    await runPluginsCommand(["plugins", ...args]);

    expect(readRenderedStatus(pluginsCliRuntimeLogs.join("\n"), format)).toBe("loaded");
  });

  it.each(
    [false, true].flatMap((runtime) =>
      [false, true].flatMap((json) =>
        ["empty", "all", "single", "missing"].map((selection) => ({ runtime, json, selection })),
      ),
    ),
  )(
    "preserves global diagnostics on stderr with $selection, runtime=$runtime, json=$json",
    async ({ runtime, json, selection }) => {
      const plugin = createPluginRecord({ id: "shared-plugin" });
      const diagnostic = { level: "warn" as const, pluginId: plugin.id, message: "Plugin warning" };
      const inspect = createInspectReport({ plugin, diagnostics: [diagnostic] });
      const reports = selection === "empty" || selection === "missing" ? [] : [inspect];
      const report = {
        plugins: reports.map((entry) => entry.plugin),
        diagnostics: [
          {
            level: "warn" as const,
            code: "workspace-scope-omitted" as const,
            message: "Workspace discovery was skipped; select the system owner.",
          },
          diagnostic,
        ],
      };
      buildPluginSnapshotReportMock.mockReturnValue(report);
      withPluginDiagnosticsReportForInspectionMock.mockImplementation(
        async (_params, formatReport) =>
          formatReport({ ...createEmptyPluginRegistry(), workspaceScope: "omitted", ...report }),
      );
      buildPluginInspectReportMock.mockReturnValue(inspect);
      buildAllPluginInspectReportsMock.mockReturnValue(reports);
      const args = [
        "plugins",
        "inspect",
        selection === "single" ? plugin.id : selection === "missing" ? "missing-plugin" : "--all",
        ...(runtime ? ["--runtime"] : []),
        ...(json ? ["--json"] : []),
      ];
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        const command = runPluginsCommand(args);
        if (selection === "missing") {
          await expect(command).rejects.toThrow("__exit__:1");
          expect(buildPluginDiagnosticsReportMock).not.toHaveBeenCalled();
          expect(withPluginDiagnosticsReportForInspectionMock).not.toHaveBeenCalled();
        } else {
          await command;
          if (json) {
            expect(pluginsCliRuntimeLogs).toHaveLength(1);
            expect(JSON.parse(pluginsCliRuntimeLogs[0] ?? "null")).toEqual(
              selection === "single" ? inspect : reports,
            );
          }
        }
        const warnings = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
        expect(warnings.match(/Workspace discovery was skipped/g)).toHaveLength(1);
        expect(warnings).not.toContain("Plugin warning");
      } finally {
        stderr.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "reports package-owned install provenance with runtime=%s",
    async (runtime) => {
      const install: PluginInstallRecord = {
        source: "npm",
        spec: "@example/pack@1.2.3",
        installPath: "/plugins/pack",
        version: "1.2.3",
        integrity: "sha512-pack",
        installedAt: "2026-08-01T00:00:00.000Z",
      };
      const plugins = ["pack/one", "pack/two"].map((id) =>
        createPluginRecord({ id, rootDir: "/plugins/pack", origin: "global" }),
      );
      setInspectInstallRecords(
        { pack: install },
        plugins.map((plugin) =>
          recordInstalledPluginIndexInstallOwner(
            {
              pluginId: plugin.id,
              rootDir: plugin.rootDir,
            },
            "pack",
          ),
        ),
      );
      buildPluginSnapshotReportMock.mockReturnValue({ plugins, diagnostics: [] });
      const reports = plugins.map((plugin) => ({ plugin }));
      buildAllPluginInspectReportsMock.mockReturnValue(reports);
      const runtimeArgs = runtime ? ["--runtime"] : [];

      for (const report of reports) {
        const { plugin } = report;
        buildPluginInspectReportMock.mockReturnValue(report);
        await runPluginsCommand(["plugins", "inspect", plugin.id, "--json", ...runtimeArgs]);
        expect(JSON.parse(pluginsCliRuntimeLogs.at(-1) ?? "null")).toMatchObject({
          plugin: { id: plugin.id },
          install,
        });
      }
      await runPluginsCommand(["plugins", "inspect", "--all", "--json", ...runtimeArgs]);
      expect(JSON.parse(pluginsCliRuntimeLogs.at(-1) ?? "null")).toEqual(
        reports.map(({ plugin }) => ({ plugin, install })),
      );
    },
  );

  it.each(["missing", "ambiguous", "conflicting"])(
    "does not attribute a same-id install when package ownership is %s",
    async (ownership) => {
      const plugin = createPluginRecord({ id: "pack/one", rootDir: "/plugins/pack" });
      setInspectInstallRecords(
        {
          pack: { source: "npm", installPath: "/plugins/pack" },
          [plugin.id]: { source: "npm", installPath: "/plugins/unrelated" },
        },
        [
          recordInstalledPluginIndexInstallOwner(
            { pluginId: plugin.id, rootDir: plugin.rootDir },
            ownership === "conflicting" ? "pack" : undefined,
            ownership === "ambiguous",
          ),
        ],
      );
      buildPluginSnapshotReportMock.mockReturnValue({ plugins: [plugin], diagnostics: [] });
      buildPluginInspectReportMock.mockReturnValue({ plugin });
      buildAllPluginInspectReportsMock.mockReturnValue([{ plugin }]);

      await runPluginsCommand(["plugins", "inspect", plugin.id, "--json"]);
      expect(JSON.parse(pluginsCliRuntimeLogs.at(-1) ?? "null")).not.toHaveProperty("install");
      await runPluginsCommand(["plugins", "inspect", "--all", "--json"]);
      expect(JSON.parse(pluginsCliRuntimeLogs.at(-1) ?? "null")[0]).not.toHaveProperty("install");
    },
  );

  it.each(["openclaw-mem0", "openclaw-mem0/core"])(
    "keeps %s inspection static and distinguishes disabled reasons from errors",
    async (pluginId) => {
      setInspectInstallRecords(
        {
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
            clawpackManifestSha256:
              "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            clawpackSize: 4096,
          },
        },
        [
          recordInstalledPluginIndexInstallOwner(
            {
              pluginId,
              rootDir: "/plugins/openclaw-mem0",
            },
            "openclaw-mem0",
          ),
        ],
      );
      buildPluginSnapshotReportMock.mockReturnValue({
        plugins: [createPluginRecord({ id: pluginId, name: "Mem0" })],
        diagnostics: [],
      });
      const inspectReport = createInspectReport({
        plugin: createPluginRecord({ id: pluginId, name: "Mem0" }),
        shape: "hook-only",
        capabilityMode: "plain",
        capabilityCount: 1,
        typedHooks: [{ name: "agent_end" }],
        services: ["mem0-background"],
        gatewayDiscoveryServices: ["mem0-discovery", "mem0-discovery-secondary"],
        mcpServers: [
          { name: "local", hasStdioTransport: true },
          { name: "remote", hasStdioTransport: false },
          { name: "broken", hasStdioTransport: false, unsupported: true },
        ],
        policy: {
          allowConversationAccess: true,
          allowedModels: [],
          hasAllowedModelsConfig: false,
        },
      });
      buildPluginInspectReportMock.mockReturnValue(inspectReport);

      await runPluginsCommand(["plugins", "inspect", pluginId]);

      expect(buildPluginDiagnosticsReportMock).not.toHaveBeenCalled();
      expect(withPluginDiagnosticsReportForInspectionMock).not.toHaveBeenCalled();
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

      await runPluginsCommand(["plugins", "inspect", pluginId, "--json"]);
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
        expect(inspectOutput).not.toContain(
          `${label === "Reason" ? "Error" : "Reason"}: ${detail}`,
        );

        if (status === "disabled") {
          await runPluginsCommand(["plugins", "inspect", id, "--json"]);
          expect(JSON.parse(pluginsCliRuntimeLogs.at(-1) ?? "null").plugin).toMatchObject({
            status: "disabled",
            error: detail,
            activationReason: detail,
          });
        }
      }
    },
  );

  it("runtime-inspects exact plugin ids and display names without repairing deps", async () => {
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [
        createPluginRecord({ id: "unrelated-plugin", name: "openclaw-mem0" }),
        createPluginRecord({ id: "openclaw-mem0", name: "Mem0" }),
      ],
      diagnostics: [],
    });
    buildPluginInspectReportMock.mockReturnValue(
      createInspectReport({
        plugin: createPluginRecord({ id: "openclaw-mem0", name: "Mem0" }),
        shape: "hook-only",
        capabilityMode: "plain",
        capabilityCount: 1,
        gatewayDiscoveryServices: ["mem0-runtime-discovery"],
      }),
    );

    for (const selector of ["openclaw-mem0", "Mem0"]) {
      await runPluginsCommand(["plugins", "inspect", selector, "--runtime"]);
      expect(withPluginDiagnosticsReportForInspectionMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          config: {},
          onlyPluginIds: ["openclaw-mem0"],
          runtimeInspection: true,
        }),
        expect.any(Function),
      );
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

    expect(buildPluginSnapshotReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ config: {} }),
    );
    expect(buildPluginDiagnosticsReportMock).not.toHaveBeenCalled();
    expect(withPluginDiagnosticsReportForInspectionMock).not.toHaveBeenCalled();
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
    if (entries) {
      expect(workshopMocks.loadMetadata).toHaveBeenCalledWith({ config, workspaceDir: undefined });
    }
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
