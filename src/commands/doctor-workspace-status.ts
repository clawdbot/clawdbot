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
import { resolveOpenClawReleaseCohortVersion } from "../infra/npm-registry-spec.js";
import type { PluginMetadataSnapshotScopeRunner } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  resolvePluginVersionDriftUpdateCommand,
  type PluginVersionDriftReport,
  type PluginVersionRestartReadiness,
} from "../plugins/plugin-version-drift.js";
import {
  buildPluginCompatibilityWarnings,
  buildPluginRegistrySnapshotReport,
} from "../plugins/status.js";
import { loadTaskFlowRegistryStateFromSqliteReadOnly } from "../tasks/task-flow-registry.store.sqlite.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";

type NoteWorkspaceStatusOptions = {
  pluginVersionReadiness?: PluginVersionRestartReadiness;
  runWithPluginMetadataSnapshot?: PluginMetadataSnapshotScopeRunner;
};

const WORKSPACE_STATUS_CHECK_ID = "core/doctor/workspace-status";

type TaskFlowRecoveryFinding = {
  flowId: string;
  message: string;
};

function collectTaskFlowRecoveryFindings(): TaskFlowRecoveryFinding[] {
  const flows = [...loadTaskFlowRegistryStateFromSqliteReadOnly().flows.values()].toSorted(
    (left, right) => right.createdAt - left.createdAt,
  );
  const tasksByFlowId = new Map<string, TaskRecord[]>();
  for (const task of loadTaskRegistryStateFromSqliteReadOnly().tasks.values()) {
    const flowId = task.parentFlowId?.trim();
    if (flowId) {
      const linkedTasks = tasksByFlowId.get(flowId);
      if (linkedTasks) {
        linkedTasks.push(task);
      } else {
        tasksByFlowId.set(flowId, [task]);
      }
    }
  }
  return flows.flatMap((flow) => {
    const linkedTasks = tasksByFlowId.get(flow.flowId) ?? [];
    const findings: TaskFlowRecoveryFinding[] = [];
    if (
      flow.syncMode === "managed" &&
      flow.status === "running" &&
      linkedTasks.length === 0 &&
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
      !linkedTasks.some((task) => task.taskId === flow.blockedTaskId)
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
  runningGatewayVersion?: string,
): HealthFinding[] {
  if (!drift) {
    return [];
  }
  if (drift.drifts.length === 0) {
    if (!isGatewayRestartPending(drift, runningGatewayVersion)) {
      return [];
    }
    return [
      {
        checkId: WORKSPACE_STATUS_CHECK_ID,
        severity: "warning",
        message: `Active official plugins match post-restart OpenClaw ${drift.gatewayVersion}, but the running Gateway is ${runningGatewayVersion}.`,
        path: "plugins",
        requirement: "plugin-version-gateway-restart",
        fixHint: formatCliCommand("openclaw gateway restart"),
      },
    ];
  }
  return drift.drifts.map((entry) => {
    const updateCommand = resolvePluginVersionDriftUpdateCommand(entry);
    const targetResolution = entry.targetResolution;
    const targetError =
      targetResolution?.status === "unresolved"
        ? targetResolution.error
        : "npm registry target was not resolved";
    return {
      checkId: WORKSPACE_STATUS_CHECK_ID,
      severity: "warning",
      message: `Plugin ${entry.pluginId} is ${entry.installedVersion}, but a Gateway restart will load OpenClaw ${drift.gatewayVersion}.${runningGatewayVersion ? ` The running Gateway is ${runningGatewayVersion}.` : ""}${updateCommand ? "" : ` Repair target resolution failed: ${targetError}.`}`,
      path: `plugins.entries.${entry.pluginId}`,
      target: entry.pluginId,
      requirement: "plugin-version-drift",
      fixHint: updateCommand
        ? `${formatCliCommand(updateCommand)} && ${formatCliCommand("openclaw gateway restart")}`
        : `No install command generated; retry openclaw doctor after checking registry availability (${targetError}).`,
    };
  });
}

function isGatewayRestartPending(
  drift: PluginVersionDriftReport,
  runningGatewayVersion: string | undefined,
): runningGatewayVersion is string {
  return Boolean(
    runningGatewayVersion &&
    resolveOpenClawReleaseCohortVersion(runningGatewayVersion) !==
      resolveOpenClawReleaseCohortVersion(drift.gatewayVersion),
  );
}

function pluginVersionReadinessToHealthFindings(
  readiness: PluginVersionRestartReadiness | undefined,
): HealthFinding[] {
  if (!readiness) {
    return [];
  }
  if (readiness.status === "resolved") {
    return pluginVersionDriftToHealthFindings(readiness.report, readiness.runningGatewayVersion);
  }
  return [
    {
      checkId: WORKSPACE_STATUS_CHECK_ID,
      severity: "warning",
      message: `Could not check plugin restart readiness: ${readiness.reason}`,
      path: "plugins",
      requirement: "plugin-version-restart-readiness",
      fixHint:
        "Repair the Gateway service installation, then rerun openclaw doctor before restarting.",
    },
  ];
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
    const collectForWorkspace = () => {
      const findings: HealthFinding[] = [];
      const prefix = agentIds.length > 1 ? `Agent "${agentId}": ` : "";
      const pluginRegistry = buildPluginRegistrySnapshotReport({ config: cfg, workspaceDir });
      const compatibilityWarnings = buildPluginCompatibilityWarnings({
        config: cfg,
        workspaceDir,
        report: pluginRegistry,
      });
      for (const message of compatibilityWarnings) {
        findings.push(pluginCompatibilityWarningToHealthFinding(`${prefix}${message}`));
      }
      for (const diagnostic of pluginRegistry.diagnostics) {
        findings.push(
          pluginDiagnosticToHealthFinding(diagnostic, `${prefix}${diagnostic.message}`),
        );
      }
      return findings;
    };
    workspaceFindings.push(
      ...(options.runWithPluginMetadataSnapshot
        ? options.runWithPluginMetadataSnapshot({ config: cfg, workspaceDir }, collectForWorkspace)
        : collectForWorkspace()),
    );
  }

  return [
    ...pluginVersionReadinessToHealthFindings(options.pluginVersionReadiness),
    ...workspaceFindings,
    ...collectTaskFlowRecoveryFindings().map(taskFlowRecoveryToHealthFinding),
  ];
}

function notePluginVersionReadiness(readiness: PluginVersionRestartReadiness | undefined) {
  if (!readiness) {
    return;
  }
  if (readiness.status === "unresolved") {
    const running = readiness.runningGatewayVersion
      ? `\nRunning Gateway: OpenClaw ${readiness.runningGatewayVersion}`
      : "";
    note(
      `${readiness.reason}${running}\nRepair the Gateway service installation, then rerun openclaw doctor before restarting.`,
      "Plugin restart readiness",
    );
    return;
  }
  const drift = readiness.report;
  if (drift.drifts.length === 0) {
    if (!isGatewayRestartPending(drift, readiness.runningGatewayVersion)) {
      return;
    }
    note(
      [
        `Running Gateway: OpenClaw ${readiness.runningGatewayVersion}`,
        `Active official plugins match post-restart OpenClaw ${drift.gatewayVersion}.`,
        `Fix: ${formatCliCommand("openclaw gateway restart")}.`,
      ].join("\n"),
      "Plugin restart readiness",
    );
    return;
  }
  const singleDrift = drift.drifts.length === 1 ? drift.drifts[0] : undefined;
  const repairs = drift.drifts.map((entry) => ({
    entry,
    command: resolvePluginVersionDriftUpdateCommand(entry),
  }));
  const updateCommands = repairs
    .map(({ command }) => command)
    .filter((command): command is string => Boolean(command))
    .map((command) => formatCliCommand(command));
  const unresolvedRepairs = repairs.filter(({ command }) => !command);
  const lines = [
    ...(readiness.runningGatewayVersion
      ? [`Running Gateway: OpenClaw ${readiness.runningGatewayVersion}`]
      : []),
    `${drift.drifts.length} active official plugin${
      drift.drifts.length === 1 ? "" : "s"
    } not on post-restart OpenClaw ${drift.gatewayVersion}`,
    ...drift.drifts.map((entry) => {
      const sourceLabel = entry.source === "clawhub" ? "clawhub" : "npm";
      return `- ${entry.pluginId}: ${entry.installedVersion} (${sourceLabel}) -> expected ${drift.gatewayVersion}`;
    }),
    ...unresolvedRepairs.map(({ entry }) => {
      const targetResolution = entry.targetResolution;
      const detail =
        targetResolution?.status === "unresolved"
          ? targetResolution.error
          : "npm registry target was not resolved";
      return `Repair target resolution failed for ${entry.pluginId}: ${detail}. No install command generated.`;
    }),
    singleDrift && updateCommands.length === 1
      ? `Fix: ${updateCommands[0]} && ${formatCliCommand("openclaw gateway restart")}.`
      : updateCommands.length > 0
        ? [
            "Fix each drifted plugin:",
            ...updateCommands.map((command) => `- ${command}`),
            ...(unresolvedRepairs.length === 0
              ? [`Then run ${formatCliCommand("openclaw gateway restart")}.`]
              : []),
          ].join("\n")
        : null,
  ];
  note(
    lines.filter((line): line is string => Boolean(line)).join("\n"),
    "Plugin restart readiness",
  );
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
    const noteForWorkspace = () => {
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
    };
    if (options.runWithPluginMetadataSnapshot) {
      options.runWithPluginMetadataSnapshot({ config: cfg, workspaceDir }, noteForWorkspace);
    } else {
      noteForWorkspace();
    }
  }
  notePluginVersionReadiness(options.pluginVersionReadiness);
  noteFlowRecoveryHints();

  return {
    workspaceDir:
      scopes.find((scope) => scope.agentId === defaultAgentId)?.workspaceDir ??
      scopes[0]?.workspaceDir,
  };
}
