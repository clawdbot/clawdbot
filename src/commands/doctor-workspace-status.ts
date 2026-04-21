import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildPluginCompatibilityWarnings, buildPluginSnapshotReport } from "../plugins/status.js";
import { listTasksForFlowId } from "../tasks/runtime-internal.js";
import { listTaskFlowRecords } from "../tasks/task-flow-runtime-internal.js";
import { note } from "../terminal/note.js";
import { detectLegacyWorkspaceDirs, formatLegacyWorkspaceWarning } from "./doctor-workspace.js";

function noteFlowRecoveryHints() {
  const suspicious = listTaskFlowRecords().flatMap((flow) => {
    const tasks = listTasksForFlowId(flow.flowId);
    const findings: string[] = [];
    if (
      flow.syncMode === "managed" &&
      flow.status === "running" &&
      tasks.length === 0 &&
      flow.waitJson === undefined
    ) {
      findings.push(
        `${flow.flowId}: running managed TaskFlow has no linked tasks or wait state; inspect or cancel it manually.`,
      );
    }
    if (
      flow.status === "blocked" &&
      flow.blockedTaskId &&
      !tasks.some((task) => task.taskId === flow.blockedTaskId)
    ) {
      findings.push(
        `${flow.flowId}: blocked TaskFlow points at missing task ${flow.blockedTaskId}; inspect before retrying.`,
      );
    }
    return findings;
  });
  if (suspicious.length === 0) {
    return;
  }
  note(
    [
      ...suspicious.slice(0, 5),
      suspicious.length > 5 ? `...and ${suspicious.length - 5} more.` : null,
      `Inspect: ${formatCliCommand("openclaw tasks flow show <flow-id>")}`,
      `Cancel: ${formatCliCommand("openclaw tasks flow cancel <flow-id>")}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    "TaskFlow recovery",
  );
}

export function noteWorkspaceStatus(cfg: OpenClawConfig) {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const legacyWorkspace = detectLegacyWorkspaceDirs({ workspaceDir });
  if (legacyWorkspace.legacyDirs.length > 0) {
    note(formatLegacyWorkspaceWarning(legacyWorkspace), "Extra workspace");
  }

  const skillsReport = buildWorkspaceSkillStatus(workspaceDir, { config: cfg });
  note(
    [
      `Eligible: ${skillsReport.skills.filter((s) => s.eligible).length}`,
      `Missing requirements: ${
        skillsReport.skills.filter((s) => !s.eligible && !s.disabled && !s.blockedByAllowlist)
          .length
      }`,
      `Blocked by allowlist: ${skillsReport.skills.filter((s) => s.blockedByAllowlist).length}`,
    ].join("\n"),
    "Skills status",
  );

  const pluginRegistry = buildPluginSnapshotReport({
    config: cfg,
    workspaceDir,
  });
  if (pluginRegistry.plugins.length > 0) {
    const loaded = pluginRegistry.plugins.filter((p) => p.status === "loaded");
    const disabled = pluginRegistry.plugins.filter((p) => p.status === "disabled");
    const errored = pluginRegistry.plugins.filter((p) => p.status === "error");
    const imported = pluginRegistry.plugins.filter((p) => p.imported);

    const lines = [
      `Loaded: ${loaded.length}`,
      `Imported: ${imported.length}`,
      `Disabled: ${disabled.length}`,
      `Errors: ${errored.length}`,
      errored.length > 0
        ? `- ${errored
            .slice(0, 10)
            .map((p) => p.id)
            .join("\n- ")}${errored.length > 10 ? "\n- ..." : ""}`
        : null,
    ].filter((line): line is string => Boolean(line));

    const bundlePlugins = loaded.filter(
      (p) => p.format === "bundle" && (p.bundleCapabilities?.length ?? 0) > 0,
    );
    if (bundlePlugins.length > 0) {
      const allCaps = new Set(bundlePlugins.flatMap((p) => p.bundleCapabilities ?? []));
      lines.push(`Bundle plugins: ${bundlePlugins.length} (${[...allCaps].toSorted().join(", ")})`);
    }

    note(lines.join("\n"), "Plugins");
  }
  const compatibilityWarnings = buildPluginCompatibilityWarnings({
    config: cfg,
    workspaceDir,
    report: pluginRegistry,
  });
  if (compatibilityWarnings.length > 0) {
    note(compatibilityWarnings.map((line) => `- ${line}`).join("\n"), "Plugin compatibility");
  }
  if (pluginRegistry.diagnostics.length > 0) {
    const lines = pluginRegistry.diagnostics.map((diag) => {
      const prefix = diag.level.toUpperCase();
      const plugin = diag.pluginId ? ` ${diag.pluginId}` : "";
      const source = diag.source ? ` (${diag.source})` : "";
      return `- ${prefix}${plugin}: ${diag.message}${source}`;
    });
    note(lines.join("\n"), "Plugin diagnostics");
  }

  noteFlowRecoveryHints();

  return { workspaceDir };
}
