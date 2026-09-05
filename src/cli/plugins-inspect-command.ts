// `openclaw plugins inspect`: renders plugin registry shape, capabilities, policy, diagnostics, and install records.
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { formatConsoleDiagnosticLine } from "../logging/json-console-line.js";
import { resolvePluginControlPlaneWorkspace } from "../plugins/control-plane-workspace.js";
import { createInstalledPluginOwnershipResolver } from "../plugins/installed-plugin-package-ownership.js";
import type { PluginDiagnostic } from "../plugins/manifest-types.js";
import { tracePluginLifecyclePhase } from "../plugins/plugin-lifecycle-trace.js";
import { formatPluginTrustDiagnostic } from "../plugins/plugin-trust.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomeInString, shortenHomePath } from "../utils.js";
import { formatMissingPluginMessage } from "./error-format.js";
import { formatCliJsonFailure } from "./failure-output.js";
import { quietPluginJsonLogger } from "./plugins-json-logger.js";
import { formatPluginBundleFormat } from "./plugins-list-format.js";

/** Options accepted by `openclaw plugins inspect`. */
export type PluginInspectOptions = {
  json?: boolean;
  all?: boolean;
  runtime?: boolean;
};

function failPluginInspect(message: string, json: boolean | undefined): void {
  if (json) {
    defaultRuntime.writeJson(formatCliJsonFailure(message));
  } else {
    defaultRuntime.error(message);
  }
  defaultRuntime.exit(1);
}

function writeGlobalPluginDiagnostics(diagnostics: readonly PluginDiagnostic[]): void {
  for (const { pluginId, level, message } of diagnostics) {
    if (!pluginId) {
      const line = formatConsoleDiagnosticLine({
        level,
        message: shortenHomeInString(`${level.toUpperCase()}: ${message}`),
      });
      // Global discovery diagnostics also matter when the JSON result is an empty array.
      process.stderr.write(`${line}\n`);
    }
  }
}

function formatInspectSection(title: string, lines: string[]): string[] {
  if (lines.length === 0) {
    return [];
  }
  return ["", theme.muted(`${title}:`), ...lines];
}

function formatCapabilityKinds(
  capabilities: Array<{
    kind: string;
  }>,
): string {
  if (capabilities.length === 0) {
    return "-";
  }
  return capabilities.map((entry) => entry.kind).join(", ");
}

function formatHookSummary(params: { typedHookCount: number; customHookCount: number }): string {
  const parts: string[] = [];
  if (params.typedHookCount > 0) {
    parts.push(`${params.typedHookCount} typed`);
  }
  if (params.customHookCount > 0) {
    parts.push(`${params.customHookCount} custom`);
  }
  return parts.length > 0 ? parts.join(", ") : "-";
}

function formatInstallLines(install: PluginInstallRecord | undefined): string[] {
  if (!install) {
    return [];
  }
  const lines = [`Source: ${install.source}`];
  if (install.spec) {
    lines.push(`Spec: ${install.spec}`);
  }
  if (install.sourcePath) {
    lines.push(`Source path: ${shortenHomePath(install.sourcePath)}`);
  }
  if (install.installPath) {
    lines.push(`Install path: ${shortenHomePath(install.installPath)}`);
  }
  if (install.version) {
    lines.push(`Recorded version: ${install.version}`);
  }
  if (install.clawhubPackage) {
    lines.push(`ClawHub package: ${install.clawhubPackage}`);
  }
  if (install.clawhubChannel) {
    lines.push(`ClawHub channel: ${install.clawhubChannel}`);
  }
  if (install.artifactKind) {
    lines.push(`Artifact kind: ${install.artifactKind}`);
  }
  if (install.artifactFormat) {
    lines.push(`Artifact format: ${install.artifactFormat}`);
  }
  if (install.npmIntegrity) {
    lines.push(`Npm integrity: ${install.npmIntegrity}`);
  }
  if (install.npmShasum) {
    lines.push(`Npm shasum: ${install.npmShasum}`);
  }
  if (install.npmTarballName) {
    lines.push(`Npm tarball: ${install.npmTarballName}`);
  }
  if (install.clawpackSha256) {
    lines.push(`ClawPack sha256: ${install.clawpackSha256}`);
  }
  if (install.clawpackSpecVersion !== undefined) {
    lines.push(`ClawPack spec: ${install.clawpackSpecVersion}`);
  }
  if (install.clawpackManifestSha256) {
    lines.push(`ClawPack manifest sha256: ${install.clawpackManifestSha256}`);
  }
  if (install.clawpackSize !== undefined) {
    lines.push(`ClawPack size: ${install.clawpackSize} bytes`);
  }
  if (install.installedAt) {
    lines.push(`Installed at: ${install.installedAt}`);
  }
  return lines;
}

/** Inspect one plugin or all plugins using either snapshot-only or runtime-loaded registry data. */
export async function runPluginsInspectCommand(
  id: string | undefined,
  opts: PluginInspectOptions,
): Promise<void> {
  const {
    buildAllPluginInspectReports,
    buildPluginDiagnosticsReport,
    buildPluginInspectReport,
    buildPluginSnapshotReport,
    formatPluginCompatibilityNotice,
  } = await import("../plugins/status.js");
  const { loadPluginMetadataSnapshot } = await import("../plugins/plugin-metadata-snapshot.js");
  const cfg = tracePluginLifecyclePhase("config read", () => getRuntimeConfig(), {
    command: "inspect",
  });
  const { workspaceDir } = resolvePluginControlPlaneWorkspace({ config: cfg });
  const metadataSnapshot = tracePluginLifecyclePhase(
    "plugin metadata load",
    () => loadPluginMetadataSnapshot({ config: cfg, workspaceDir }),
    { command: "inspect" },
  );
  const ownershipResolver = createInstalledPluginOwnershipResolver(metadataSnapshot.index);
  const resolveInstallRecord = (pluginId: string) => {
    // Runtime child ids need the package owner's record; ambiguous ownership
    // must not borrow provenance from an unrelated same-id install.
    const ownership = ownershipResolver.resolvePackage(pluginId);
    return ownership.ok ? ownership.value.installRecord : undefined;
  };
  const loggerParams = opts.json ? { logger: quietPluginJsonLogger } : {};
  const runtimeInspect = opts.runtime === true;
  const reportParams = { config: cfg, metadataSnapshot, ...loggerParams };
  const runtimeReportParams = {
    ...reportParams,
    runtimeInspection: true,
  };
  if (opts.all) {
    if (id) {
      failPluginInspect("Pass either a plugin id or --all, not both.", opts.json);
      return;
    }
    const report = runtimeInspect
      ? tracePluginLifecyclePhase(
          "runtime plugin registry load",
          () => buildPluginDiagnosticsReport(runtimeReportParams),
          { command: "inspect", all: true },
        )
      : tracePluginLifecyclePhase(
          "plugin registry snapshot",
          () => buildPluginSnapshotReport(reportParams),
          { command: "inspect", all: true },
        );
    writeGlobalPluginDiagnostics(report.diagnostics);
    const inspectAll = buildAllPluginInspectReports({
      config: cfg,
      ...loggerParams,
      report,
    });
    const inspectAllWithInstall = inspectAll.map((inspect) => ({
      ...inspect,
      install: resolveInstallRecord(inspect.plugin.id),
    }));

    if (opts.json) {
      defaultRuntime.writeJson(inspectAllWithInstall);
      return;
    }

    const tableWidth = getTerminalTableWidth();
    const rows = inspectAll.map((inspect) => ({
      Name: inspect.plugin.name || inspect.plugin.id,
      ID: inspect.plugin.name && inspect.plugin.name !== inspect.plugin.id ? inspect.plugin.id : "",
      Status:
        inspect.plugin.status === "loaded"
          ? theme.success("loaded")
          : inspect.plugin.status === "disabled"
            ? theme.warn("disabled")
            : theme.error("error"),
      Shape: inspect.shape,
      Capabilities: formatCapabilityKinds(inspect.capabilities),
      Compatibility:
        inspect.compatibility.length > 0
          ? inspect.compatibility
              .map((entry) => (entry.severity === "warn" ? `warn:${entry.code}` : entry.code))
              .join(", ")
          : "none",
      Bundle: inspect.bundleCapabilities.length > 0 ? inspect.bundleCapabilities.join(", ") : "-",
      Hooks: formatHookSummary({
        typedHookCount: inspect.typedHooks.length,
        customHookCount: inspect.customHooks.length,
      }),
    }));
    defaultRuntime.log(
      renderTable({
        width: tableWidth,
        columns: [
          { key: "Name", header: "Name", minWidth: 14, flex: true },
          { key: "ID", header: "ID", minWidth: 10, flex: true },
          { key: "Status", header: "Status", minWidth: 10 },
          { key: "Shape", header: "Shape", minWidth: 18 },
          { key: "Capabilities", header: "Capabilities", minWidth: 28, flex: true },
          { key: "Compatibility", header: "Compatibility", minWidth: 24, flex: true },
          { key: "Bundle", header: "Bundle", minWidth: 14, flex: true },
          { key: "Hooks", header: "Hooks", minWidth: 20, flex: true },
        ],
        rows,
      }).trimEnd(),
    );
    return;
  }

  if (!id) {
    failPluginInspect("Provide a plugin id or use --all.", opts.json);
    return;
  }

  const snapshotReport = tracePluginLifecyclePhase(
    "plugin registry snapshot",
    () => buildPluginSnapshotReport(reportParams),
    { command: "inspect" },
  );
  const targetPlugin =
    snapshotReport.plugins.find((entry) => entry.id === id) ??
    snapshotReport.plugins.find((entry) => entry.name === id);
  if (!targetPlugin) {
    writeGlobalPluginDiagnostics(snapshotReport.diagnostics);
    if (id === "skill-workshop") {
      const { detectSkillWorkshopToolPolicyDiagnostic } =
        await import("../skills/workshop/tool-policy-diagnostic.js");
      // An explicit multi-agent roster has no single default diagnostic owner.
      const agentIds = listAgentIds(cfg);
      const lines = [
        "Skill Workshop is built into OpenClaw, not a plugin; configure it under skills.workshop.",
      ];
      for (const agentId of agentIds.length > 0 ? agentIds : [undefined]) {
        const diagnostic = detectSkillWorkshopToolPolicyDiagnostic({
          config: cfg,
          // Invoking the legacy inspect id is explicit Workshop intent even when
          // autonomous capture is off; report manual-tool availability too.
          workshopEnabled: true,
          ...(agentId ? { agentId } : {}),
        });
        if (diagnostic) {
          lines.push(diagnostic.message);
        }
      }
      failPluginInspect(lines.join("\n"), opts.json);
      return;
    }
    failPluginInspect(formatMissingPluginMessage({ id, includeSearch: true }), opts.json);
    return;
  }
  const report = runtimeInspect
    ? tracePluginLifecyclePhase(
        "runtime plugin registry load",
        () =>
          buildPluginDiagnosticsReport({
            ...runtimeReportParams,
            onlyPluginIds: [targetPlugin.id],
          }),
        { command: "inspect", pluginId: targetPlugin.id },
      )
    : snapshotReport;
  writeGlobalPluginDiagnostics(report.diagnostics);
  const inspect = buildPluginInspectReport({
    id: targetPlugin.id,
    config: cfg,
    ...loggerParams,
    report,
  });
  if (!inspect) {
    failPluginInspect(
      formatMissingPluginMessage({ id, listCommand: "openclaw plugins list --json" }),
      opts.json,
    );
    return;
  }
  const install = resolveInstallRecord(inspect.plugin.id);

  if (opts.json) {
    defaultRuntime.writeJson({
      ...inspect,
      install,
    });
    return;
  }

  const lines: string[] = [];
  lines.push(theme.heading(inspect.plugin.name || inspect.plugin.id));
  if (inspect.plugin.name && inspect.plugin.name !== inspect.plugin.id) {
    lines.push(theme.muted(`id: ${inspect.plugin.id}`));
  }
  if (inspect.plugin.description) {
    lines.push(inspect.plugin.description);
  }
  lines.push("");
  lines.push(`${theme.muted("Status:")} ${inspect.plugin.status}`);
  if (inspect.plugin.failurePhase) {
    lines.push(`${theme.muted("Failure phase:")} ${inspect.plugin.failurePhase}`);
  }
  if (inspect.plugin.failedAt) {
    lines.push(`${theme.muted("Failed at:")} ${inspect.plugin.failedAt.toISOString()}`);
  }
  lines.push(`${theme.muted("Format:")} ${inspect.plugin.format ?? "openclaw"}`);
  if (inspect.plugin.bundleFormat) {
    lines.push(
      `${theme.muted("Bundle format:")} ${formatPluginBundleFormat(inspect.plugin.bundleFormat)}`,
    );
  }
  lines.push(`${theme.muted("Source:")} ${shortenHomeInString(inspect.plugin.source)}`);
  lines.push(`${theme.muted("Origin:")} ${inspect.plugin.origin}`);
  if (inspect.plugin.trust) {
    lines.push(`${theme.muted("Trust:")} ${formatPluginTrustDiagnostic(inspect.plugin.trust)}`);
  }
  if (inspect.plugin.version) {
    lines.push(`${theme.muted("Version:")} ${inspect.plugin.version}`);
  }
  lines.push(`${theme.muted("Shape:")} ${inspect.shape}`);
  lines.push(`${theme.muted("Capability mode:")} ${inspect.capabilityMode}`);
  if (inspect.bundleCapabilities.length > 0) {
    lines.push(`${theme.muted("Bundle capabilities:")} ${inspect.bundleCapabilities.join(", ")}`);
  }
  lines.push(
    ...formatInspectSection(
      "Capabilities",
      inspect.capabilities.map(
        (entry) => `${entry.kind}: ${entry.ids.length > 0 ? entry.ids.join(", ") : "(registered)"}`,
      ),
    ),
  );
  lines.push(
    ...formatInspectSection(
      "Typed hooks",
      inspect.typedHooks.map((entry) =>
        entry.priority == null ? entry.name : `${entry.name} (priority ${entry.priority})`,
      ),
    ),
  );
  lines.push(
    ...formatInspectSection(
      "Compatibility warnings",
      inspect.compatibility.map(formatPluginCompatibilityNotice),
    ),
  );
  lines.push(
    ...formatInspectSection(
      "Custom hooks",
      inspect.customHooks.map((entry) => `${entry.name}: ${entry.events.join(", ")}`),
    ),
  );
  lines.push(
    ...formatInspectSection(
      "Tools",
      inspect.tools.map((entry) => {
        const names = entry.names.length > 0 ? entry.names.join(", ") : "(anonymous)";
        return entry.optional ? `${names} [optional]` : names;
      }),
    ),
  );
  lines.push(...formatInspectSection("Commands", inspect.commands));
  lines.push(...formatInspectSection("CLI commands", inspect.cliCommands));
  lines.push(...formatInspectSection("Services", inspect.services));
  lines.push(...formatInspectSection("Gateway discovery", inspect.gatewayDiscoveryServices));
  lines.push(...formatInspectSection("Gateway methods", inspect.gatewayMethods ?? []));
  lines.push(
    ...formatInspectSection(
      "MCP servers",
      inspect.mcpServers.map((entry) =>
        entry.unsupported ? `${entry.name} (unsupported transport)` : entry.name,
      ),
    ),
  );
  lines.push(
    ...formatInspectSection(
      "LSP servers",
      inspect.lspServers.map((entry) =>
        entry.hasStdioTransport ? entry.name : `${entry.name} (unsupported transport)`,
      ),
    ),
  );
  if (inspect.httpRouteCount > 0) {
    lines.push(...formatInspectSection("HTTP routes", [String(inspect.httpRouteCount)]));
  }
  const policyLines: string[] = [];
  if (typeof inspect.policy.allowPromptInjection === "boolean") {
    policyLines.push(`allowPromptInjection: ${inspect.policy.allowPromptInjection}`);
  }
  if (typeof inspect.policy.allowConversationAccess === "boolean") {
    policyLines.push(`allowConversationAccess: ${inspect.policy.allowConversationAccess}`);
  }
  if (typeof inspect.policy.allowModelOverride === "boolean") {
    policyLines.push(`allowModelOverride: ${inspect.policy.allowModelOverride}`);
  }
  if (inspect.policy.hasAllowedModelsConfig) {
    policyLines.push(
      `allowedModels: ${
        inspect.policy.allowedModels.length > 0
          ? inspect.policy.allowedModels.join(", ")
          : "(configured but empty)"
      }`,
    );
  }
  lines.push(...formatInspectSection("Policy", policyLines));
  lines.push(
    ...formatInspectSection(
      "Diagnostics",
      inspect.diagnostics.map((entry) => `${entry.level.toUpperCase()}: ${entry.message}`),
    ),
  );
  lines.push(...formatInspectSection("Install", formatInstallLines(install)));
  if (inspect.plugin.error) {
    const label =
      inspect.plugin.status === "error" ? theme.error("Error:") : theme.muted("Reason:");
    lines.push("", `${label} ${inspect.plugin.error}`);
  }
  defaultRuntime.log(lines.join("\n"));
}
