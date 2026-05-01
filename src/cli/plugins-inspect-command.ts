import { getRuntimeConfig } from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  tracePluginLifecyclePhase,
  tracePluginLifecyclePhaseAsync,
} from "../plugins/plugin-lifecycle-trace.js";
import { defaultRuntime } from "../runtime.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { shortenHomeInString, shortenHomePath } from "../utils.js";
import { quietPluginJsonLogger } from "./plugins-command-helpers.js";

export type PluginInspectOptions = {
  json?: boolean;
  all?: boolean;
  runtime?: boolean;
};

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

function formatHookSummary(params: {
  usesLegacyBeforeAgentStart: boolean;
  typedHookCount: number;
  customHookCount: number;
}): string {
  const parts: string[] = [];
  if (params.usesLegacyBeforeAgentStart) {
    parts.push("before_agent_start");
  }
  const nonLegacyTypedHookCount =
    params.typedHookCount - (params.usesLegacyBeforeAgentStart ? 1 : 0);
  if (nonLegacyTypedHookCount > 0) {
    parts.push(`${nonLegacyTypedHookCount} typed`);
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
  if (install.installedAt) {
    lines.push(`Installed at: ${install.installedAt}`);
  }
  return lines;
}

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
  const { loadInstalledPluginIndexInstallRecords } =
    await import("../plugins/installed-plugin-index-records.js");
  const cfg = tracePluginLifecyclePhase("config read", () => getRuntimeConfig(), {
    command: "inspect",
  });
  const installRecords = await tracePluginLifecyclePhaseAsync(
    "install records load",
    () => loadInstalledPluginIndexInstallRecords(),
    { command: "inspect" },
  );
  const loggerParams = opts.json ? { logger: quietPluginJsonLogger } : {};
  const runtimeInspect = opts.runtime === true;
  if (opts.all) {
    if (id) {
      defaultRuntime.error("Pass either a plugin id or --all, not both.");
      return defaultRuntime.exit(1);
    }
    const report = runtimeInspect
      ? tracePluginLifecyclePhase(
          "runtime plugin registry load",
          () =>
            buildPluginDiagnosticsReport({
              config: cfg,
              ...loggerParams,
            }),
          { command: "inspect", all: true },
        )
      : tracePluginLifecyclePhase(
          "plugin registry snapshot",
          () =>
            buildPluginSnapshotReport({
              config: cfg,
              ...loggerParams,
            }),
          { command: "inspect", all: true },
        );
    const inspectAll = buildAllPluginInspectReports({
      config: cfg,
      ...loggerParams,
      report,
    });
    const inspectAllWithInstall = inspectAll.map((inspect) => ({
      ...inspect,
      install: installRecords[inspect.plugin.id],
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
        usesLegacyBeforeAgentStart: inspect.usesLegacyBeforeAgentStart,
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
    defaultRuntime.error("Provide a plugin id or use --all.");
    return defaultRuntime.exit(1);
  }

  const snapshotReport = tracePluginLifecyclePhase(
    "plugin registry snapshot",
    () =>
      buildPluginSnapshotReport({
        config: cfg,
        ...loggerParams,
      }),
    { command: "inspect" },
  );
  const targetPlugin = snapshotReport.plugins.find((entry) => entry.id === id || entry.name === id);
  if (!targetPlugin) {
    defaultRuntime.error(`Plugin not found: ${id}`);
    return defaultRuntime.exit(1);
  }
  const report = runtimeInspect
    ? tracePluginLifecyclePhase(
        "runtime plugin registry load",
        () =>
          buildPluginDiagnosticsReport({
            config: cfg,
            ...loggerParams,
            onlyPluginIds: [targetPlugin.id],
          }),
        { command: "inspect", pluginId: targetPlugin.id },
      )
    : snapshotReport;
  const inspect = buildPluginInspectReport({
    id: targetPlugin.id,
    config: cfg,
    ...loggerParams,
    report,
  });
  if (!inspect) {
    defaultRuntime.error(`Plugin not found: ${id}`);
    return defaultRuntime.exit(1);
  }
  const install = installRecords[inspect.plugin.id];

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
    lines.push(`${theme.muted("Bundle format:")} ${inspect.plugin.bundleFormat}`);
  }
  lines.push(`${theme.muted("Source:")} ${shortenHomeInString(inspect.plugin.source)}`);
  lines.push(`${theme.muted("Origin:")} ${inspect.plugin.origin}`);
  if (inspect.plugin.version) {
    lines.push(`${theme.muted("Version:")} ${inspect.plugin.version}`);
  }
  lines.push(`${theme.muted("Shape:")} ${inspect.shape}`);
  lines.push(`${theme.muted("Capability mode:")} ${inspect.capabilityMode}`);
  lines.push(
    `${theme.muted("Legacy before_agent_start:")} ${inspect.usesLegacyBeforeAgentStart ? "yes" : "no"}`,
  );
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
  lines.push(...formatInspectSection("Gateway methods", inspect.gatewayMethods));
  lines.push(
    ...formatInspectSection(
      "MCP servers",
      inspect.mcpServers.map((entry) =>
        entry.hasStdioTransport ? entry.name : `${entry.name} (unsupported transport)`,
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
    lines.push("", `${theme.error("Error:")} ${inspect.plugin.error}`);
  }
  defaultRuntime.log(lines.join("\n"));
}
