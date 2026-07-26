/** Doctor status summary for workspace skills, plugins, and task-flow recovery hints. */
import { note } from "../../packages/terminal-core/src/note.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  tryResolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import {
  resolvePluginVersionDriftUpdateCommand,
  type PluginVersionDriftReport,
} from "../plugins/plugin-version-drift.js";
import {
  buildPluginCompatibilityWarnings,
  buildPluginRegistrySnapshotReport,
} from "../plugins/status.js";
import { listTasksForFlowId } from "../tasks/runtime-internal.js";
import { listTaskFlowRecords } from "../tasks/task-flow-runtime-internal.js";

type NoteWorkspaceStatusOptions = {
  pluginVersionDrift?: PluginVersionDriftReport;
};

const WORKSPACE_STATUS_CHECK_ID = "core/doctor/workspace-status";

type TaskFlowRecoveryFinding = {
  flowId: string;
  message: string;
};

function collectTaskFlowRecoveryFindings(): TaskFlowRecoveryFinding[] {
  return listTaskFlowRecords().flatMap((flow) => {
    const tasks = listTasksForFlowId(flow.flowId);
    const findings: TaskFlowRecoveryFinding[] = [];
    if (
      flow.syncMode === "managed" &&
      flow.status === "running" &&
      tasks.length === 0 &&
      flow.waitJson === undefined
    ) {
      findings.push({
        flowId: flow.flowId,
        message: `${flow.flowId}: running managed TaskFlow has no linked tasks or wait state; inspect or cancel it manually.`,
      });
    }
    if (
      flow.endedAt == null &&
      flow.status === "blocked" &&
      flow.blockedTaskId &&
      !tasks.some((task) => task.taskId === flow.blockedTaskId)
    ) {
      findings.push({
        flowId: flow.flowId,
        message: `${flow.flowId}: blocked TaskFlow points at missing task ${flow.blockedTaskId}; inspect before retrying.`,
      });
    }
    return findings;
  });
}

function noteFlowRecoveryHints() {
  const suspicious = collectTaskFlowRecoveryFindings();
  if (suspicious.length === 0) {
    return;
  }
  note(
    [
      ...suspicious.slice(0, 5).map((finding) => finding.message),
      suspicious.length > 5 ? `...and ${suspicious.length - 5} more.` : null,
      `Inspect: ${formatCliCommand("openclaw tasks flow show <flow-id>")}`,
      `Cancel: ${formatCliCommand("openclaw tasks flow cancel <flow-id>")}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    "TaskFlow recovery",
  );
}

function pluginVersionDriftToHealthFindings(
  drift: PluginVersionDriftReport | undefined,
): HealthFinding[] {
  if (!drift || drift.drifts.length === 0) {
    return [];
  }
  return drift.drifts.map((entry) => {
    const updateCommand = formatCliCommand(resolvePluginVersionDriftUpdateCommand(entry));
    return {
      checkId: WORKSPACE_STATUS_CHECK_ID,
      severity: "warning",
      message: `Plugin ${entry.pluginId} is ${entry.installedVersion}, but the Gateway is ${drift.gatewayVersion}.`,
      path: `plugins.entries.${entry.pluginId}`,
      target: entry.pluginId,
      requirement: "plugin-version-drift",
      fixHint: `${updateCommand} && ${formatCliCommand("openclaw gateway restart")}`,
    };
  });
}

function pluginCompatibilityWarningToHealthFinding(message: string): HealthFinding {
  return {
    checkId: WORKSPACE_STATUS_CHECK_ID,
    severity: "warning",
    message,
    path: "plugins",
    requirement: "plugin-compatibility",
    fixHint: "Update or replace the plugin so it no longer depends on legacy compatibility paths.",
  };
}

function pluginDiagnosticToHealthFinding(
  diagnostic: ReturnType<typeof buildPluginRegistrySnapshotReport>["diagnostics"][number],
  message = diagnostic.message,
): HealthFinding {
  return {
    checkId: WORKSPACE_STATUS_CHECK_ID,
    severity: diagnostic.level === "error" ? "error" : "warning",
    message,
    ...(diagnostic.pluginId ? { path: `plugins.entries.${diagnostic.pluginId}` } : {}),
    ...(diagnostic.pluginId ? { target: diagnostic.pluginId } : {}),
    ...(diagnostic.source ? { source: diagnostic.source } : {}),
    ...(diagnostic.code ? { requirement: diagnostic.code } : { requirement: "plugin-diagnostic" }),
  };
}

function taskFlowRecoveryToHealthFinding(finding: TaskFlowRecoveryFinding): HealthFinding {
  return {
    checkId: WORKSPACE_STATUS_CHECK_ID,
    severity: "warning",
    message: finding.message,
    path: "tasks.flows",
    target: finding.flowId,
    requirement: "taskflow-recovery",
    fixHint: [
      formatCliCommand(`openclaw tasks flow show ${finding.flowId}`),
      formatCliCommand(`openclaw tasks flow cancel ${finding.flowId}`),
    ].join(" or "),
  };
}

export function collectWorkspaceStatusHealthFindings(
  cfg: OpenClawConfig,
  options: NoteWorkspaceStatusOptions = {},
): HealthFinding[] {
  const agentIds = listAgentIds(cfg);
  const scopes = agentIds.map((agentId) => ({
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
  }));
  const workspaceFindings: HealthFinding[] = [];
  for (const { agentId, workspaceDir } of scopes) {
    const prefix = agentIds.length > 1 ? `Agent "${agentId}": ` : "";
    const pluginRegistry = buildPluginRegistrySnapshotReport({ config: cfg, workspaceDir });
    const compatibilityWarnings = buildPluginCompatibilityWarnings({
      config: cfg,
      workspaceDir,
      report: pluginRegistry,
    });
    for (const message of compatibilityWarnings) {
      workspaceFindings.push(pluginCompatibilityWarningToHealthFinding(`${prefix}${message}`));
    }
    for (const diagnostic of pluginRegistry.diagnostics) {
      workspaceFindings.push(
        pluginDiagnosticToHealthFinding(diagnostic, `${prefix}${diagnostic.message}`),
      );
    }
  }

  return [
    ...pluginVersionDriftToHealthFindings(options.pluginVersionDrift),
    ...workspaceFindings,
    ...collectTaskFlowRecoveryFindings().map(taskFlowRecoveryToHealthFinding),
  ];
}

function notePluginVersionDrift(drift: PluginVersionDriftReport | undefined) {
  if (!drift || drift.drifts.length === 0) {
    return;
  }
  const singleDrift = drift.drifts.length === 1 ? drift.drifts[0] : undefined;
  const updateCommands = drift.drifts.map((entry) =>
    formatCliCommand(resolvePluginVersionDriftUpdateCommand(entry)),
  );
  const lines = [
    `${drift.drifts.length} active official plugin${
      drift.drifts.length === 1 ? "" : "s"
    } not on OpenClaw ${drift.gatewayVersion}`,
    ...drift.drifts.map((entry) => {
      const sourceLabel = entry.source === "clawhub" ? "clawhub" : "npm";
      return `- ${entry.pluginId}: ${entry.installedVersion} (${sourceLabel}) -> expected ${drift.gatewayVersion}`;
    }),
    singleDrift
      ? `Fix: ${updateCommands[0]} && ${formatCliCommand("openclaw gateway restart")}.`
      : [
          "Fix each drifted plugin:",
          ...updateCommands.map((command) => `- ${command}`),
          `Then run ${formatCliCommand("openclaw gateway restart")}.`,
        ].join("\n"),
  ];
  note(lines.join("\n"), "Plugin version drift");
}

/** Emits plugin and TaskFlow recovery problem notes for doctor. */
export function noteWorkspaceStatus(cfg: OpenClawConfig, options: NoteWorkspaceStatusOptions = {}) {
  const defaultAgentId = tryResolveDefaultAgentId(cfg);
  const agentIds = listAgentIds(cfg);
  const scopes = agentIds.map((agentId) => ({
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
  }));
  for (const { agentId, workspaceDir } of scopes) {
    const prefix = agentIds.length > 1 ? `Agent "${agentId}":\n` : "";
    const pluginRegistry = buildPluginRegistrySnapshotReport({ config: cfg, workspaceDir });
    const errored = pluginRegistry.plugins
      .filter((plugin) => plugin.status === "error")
      .toSorted((a, b) => a.id.localeCompare(b.id));
    if (errored.length > 0) {
      const lines = [
        `${prefix}Errors: ${errored.length}`,
        `- ${errored
          .slice(0, 10)
          .map((plugin) => plugin.id)
          .join("\n- ")}${errored.length > 10 ? "\n- ..." : ""}`,
      ];
      note(lines.join("\n"), "Plugins");
    }
    const compatibilityWarnings = buildPluginCompatibilityWarnings({
      config: cfg,
      workspaceDir,
      report: pluginRegistry,
    });
    if (compatibilityWarnings.length > 0) {
      note(
        `${prefix}${compatibilityWarnings.map((line) => `- ${line}`).join("\n")}`,
        "Plugin compatibility",
      );
    }
    if (pluginRegistry.diagnostics.length > 0) {
      const lines = pluginRegistry.diagnostics.map((diag) => {
        const level = diag.level.toUpperCase();
        const plugin = diag.pluginId ? ` ${diag.pluginId}` : "";
        const source = diag.source ? ` (${diag.source})` : "";
        return `- ${level}${plugin}: ${diag.message}${source}`;
      });
      note(`${prefix}${lines.join("\n")}`, "Plugin diagnostics");
    }
  }
  notePluginVersionDrift(options.pluginVersionDrift);
  noteFlowRecoveryHints();

  return {
    workspaceDir:
      scopes.find((scope) => scope.agentId === defaultAgentId)?.workspaceDir ??
      scopes[0]?.workspaceDir,
  };
}
