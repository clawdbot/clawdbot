/** Doctor repair for HEARTBEAT.md files that accidentally contain docs template wrappers. */
import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveWorkspaceTemplateDir } from "../agents/workspace-templates.js";
import { DEFAULT_HEARTBEAT_FILENAME } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { formatErrorMessage } from "../infra/errors.js";
import { writeTextAtomic } from "../infra/json-files.js";
import { shortenHomePath } from "../utils.js";

const HEARTBEAT_TEMPLATE_CHECK_ID = "core/doctor/heartbeat-template";

const LEGACY_HEARTBEAT_PROSE_TEMPLATE = [
  "# HEARTBEAT.md",
  "Keep this file empty unless you want a tiny checklist. Keep it small.",
] as const;

const LEGACY_HEARTBEAT_HEADING_FENCED_TEMPLATE = [
  "# HEARTBEAT.md Template",
  "```markdown",
  "# Keep this file empty (or with only comments) to skip heartbeat API calls.",
  "# Add tasks below when you want the agent to check something periodically.",
  "```",
] as const;

const LEGACY_HEARTBEAT_FENCED_TEMPLATE = [
  "```markdown",
  "# Keep this file empty (or with only comments) to skip heartbeat API calls.",
  "# Add tasks below when you want the agent to check something periodically.",
  "```",
] as const;

const LEGACY_HEARTBEAT_FENCED_RELATED_TEMPLATE = [
  "```markdown",
  "# Keep this file empty (or with only comments) to skip heartbeat API calls.",
  "# Add tasks below when you want the agent to check something periodically.",
  "```",
  "## Related",
  "- [Heartbeat config](/gateway/config-agents)",
] as const;

const DOCS_HEARTBEAT_TEMPLATE_PAGE_AS_TEMPLATE = [
  "# HEARTBEAT.md template",
  "`HEARTBEAT.md` lives in the agent workspace. Keep the file empty, or with only Markdown comments and headings, when you want OpenClaw to skip heartbeat model calls.",
  "The default runtime template is:",
  "```markdown",
  "# Keep this file empty (or with only comments) to skip heartbeat API calls.",
  "# Add tasks below when you want the agent to check something periodically.",
  "```",
  "Add short tasks below the comments only when you want the agent to check something periodically. Keep heartbeat instructions small because they are read during recurring wakes.",
  "## Related",
  "- [Heartbeat config](/gateway/config-agents)",
] as const;

const HEARTBEAT_DEFAULT_BODY_LINES = [
  "# Keep this file empty (or with only comments) to skip heartbeat API calls.",
  "# Add tasks below when you want the agent to check something periodically.",
] as const;

const DIRTY_HEARTBEAT_DOC_WRAPPER_LINES = new Set([
  "```markdown",
  "# HEARTBEAT.md Template",
  "# HEARTBEAT.md template",
  "- [Heartbeat config](/gateway/config-agents)",
]);

const KNOWN_DIRTY_HEARTBEAT_TEMPLATE_LINES = new Set([
  "```markdown",
  "```",
  "# HEARTBEAT.md Template",
  "# HEARTBEAT.md template",
  "`HEARTBEAT.md` lives in the agent workspace. Keep the file empty, or with only Markdown comments and headings, when you want OpenClaw to skip heartbeat model calls.",
  "The default runtime template is:",
  "Add short tasks below the comments only when you want the agent to check something periodically. Keep heartbeat instructions small because they are read during recurring wakes.",
  ...LEGACY_HEARTBEAT_PROSE_TEMPLATE,
  "# Keep this file empty (or with only comments) to skip heartbeat API calls.",
  "# Add tasks below when you want the agent to check something periodically.",
  "## Related",
  "- [Heartbeat config](/gateway/config-agents)",
]);

const KNOWN_REPAIRABLE_DIRTY_HEARTBEAT_TEMPLATES = [
  LEGACY_HEARTBEAT_PROSE_TEMPLATE,
  LEGACY_HEARTBEAT_HEADING_FENCED_TEMPLATE,
  LEGACY_HEARTBEAT_FENCED_TEMPLATE,
  LEGACY_HEARTBEAT_FENCED_RELATED_TEMPLATE,
  DOCS_HEARTBEAT_TEMPLATE_PAGE_AS_TEMPLATE,
] as const;

type HeartbeatTemplateRepairAnalysis =
  | { status: "clean" }
  | { status: "dirty-template" }
  | { status: "dirty-template-with-custom-content"; customLines: string[] };

function linesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

/** Classifies heartbeat template content as clean, repairable, or risky because it has user text. */
function analyzeHeartbeatTemplateForRepair(content: string): HeartbeatTemplateRepairAnalysis {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (KNOWN_REPAIRABLE_DIRTY_HEARTBEAT_TEMPLATES.some((template) => linesEqual(lines, template))) {
    return { status: "dirty-template" };
  }

  const hasDefaultTemplateBody = HEARTBEAT_DEFAULT_BODY_LINES.every((line) => lines.includes(line));
  const hasDirtyDocWrapper = lines.some((line) => DIRTY_HEARTBEAT_DOC_WRAPPER_LINES.has(line));
  const hasLegacyProseTemplate = LEGACY_HEARTBEAT_PROSE_TEMPLATE.every((line) =>
    lines.includes(line),
  );
  if ((!hasDefaultTemplateBody || !hasDirtyDocWrapper) && !hasLegacyProseTemplate) {
    return { status: "clean" };
  }
  const customLines = lines.filter((line) => !KNOWN_DIRTY_HEARTBEAT_TEMPLATE_LINES.has(line));
  return { status: "dirty-template-with-custom-content", customLines };
}

async function readCleanHeartbeatTemplate(): Promise<string> {
  const templateDir = await resolveWorkspaceTemplateDir();
  const templatePath = path.join(templateDir, DEFAULT_HEARTBEAT_FILENAME);
  return await fs.readFile(templatePath, "utf-8");
}

function heartbeatTemplateAnalysisToHealthFinding(
  agentId: string,
  labelAgent: boolean,
  heartbeatPath: string,
  analysis: Exclude<HeartbeatTemplateRepairAnalysis, { status: "clean" }>,
): HealthFinding {
  if (analysis.status === "dirty-template-with-custom-content") {
    return {
      checkId: HEARTBEAT_TEMPLATE_CHECK_ID,
      severity: "warning",
      message: `${labelAgent ? `Agent "${agentId}": ` : ""}HEARTBEAT.md contains an older heartbeat template wrapper plus custom or unrecognized content.`,
      path: heartbeatPath,
      ...(labelAgent ? { target: agentId } : {}),
      requirement: "legacy-template-with-custom-content",
      fixHint: "Remove the fenced template and Related lines manually if they are not intentional.",
    };
  }
  return {
    checkId: HEARTBEAT_TEMPLATE_CHECK_ID,
    severity: "warning",
    message: `${labelAgent ? `Agent "${agentId}": ` : ""}HEARTBEAT.md contains an older heartbeat documentation template.`,
    path: heartbeatPath,
    ...(labelAgent ? { target: agentId } : {}),
    requirement: "legacy-template",
    fixHint: 'Run "openclaw doctor --fix" to replace it with the clean heartbeat template.',
  };
}

/** Collects read-only structured findings for legacy HEARTBEAT.md template wrappers. */
export async function collectHeartbeatTemplateHealthFindings(
  cfg: OpenClawConfig,
  deps?: {
    readFile?: (filePath: string) => Promise<string>;
  },
): Promise<readonly HealthFinding[]> {
  const agentIds = listAgentIds(cfg);
  const labelAgents = agentIds.length > 1;
  const targets = agentIds.map((agentId) => ({
    agentId,
    heartbeatPath: path.join(resolveAgentWorkspaceDir(cfg, agentId), DEFAULT_HEARTBEAT_FILENAME),
  }));
  const readFile = deps?.readFile ?? ((filePath: string) => fs.readFile(filePath, "utf-8"));
  const findings: HealthFinding[] = [];
  for (const { agentId, heartbeatPath } of targets) {
    let content: string;
    try {
      content = await readFile(heartbeatPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        continue;
      }
      findings.push({
        checkId: HEARTBEAT_TEMPLATE_CHECK_ID,
        severity: "warning",
        message: `${labelAgents ? `Agent "${agentId}": ` : ""}Could not inspect HEARTBEAT.md: ${formatErrorMessage(error)}`,
        path: heartbeatPath,
        ...(labelAgents ? { target: agentId } : {}),
        requirement: "inspect-failed",
        fixHint: "Check file permissions, then rerun doctor.",
      });
      continue;
    }

    const analysis = analyzeHeartbeatTemplateForRepair(content);
    if (analysis.status !== "clean") {
      findings.push(
        heartbeatTemplateAnalysisToHealthFinding(agentId, labelAgents, heartbeatPath, analysis),
      );
    }
  }
  return findings;
}

/** Replaces known dirty heartbeat templates with the clean runtime template when repair is enabled. */
export async function maybeRepairHeartbeatTemplate(params: {
  cfg: OpenClawConfig;
  shouldRepair: boolean;
}): Promise<void> {
  const agentIds = listAgentIds(params.cfg);
  const labelAgents = agentIds.length > 1;
  const targets = agentIds.map((agentId) => ({
    agentId,
    heartbeatPath: path.join(
      resolveAgentWorkspaceDir(params.cfg, agentId),
      DEFAULT_HEARTBEAT_FILENAME,
    ),
  }));
  for (const { agentId, heartbeatPath } of targets) {
    const prefix = labelAgents ? `Agent "${agentId}": ` : "";
    let content: string;
    try {
      content = await fs.readFile(heartbeatPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        continue;
      }
      note(
        `${prefix}Could not inspect ${shortenHomePath(heartbeatPath)}: ${formatErrorMessage(error)}`,
        "Heartbeat template",
      );
      continue;
    }

    const analysis = analyzeHeartbeatTemplateForRepair(content);
    if (analysis.status === "clean") {
      continue;
    }
    if (analysis.status === "dirty-template-with-custom-content") {
      note(
        [
          `${prefix}${shortenHomePath(heartbeatPath)} contains an older heartbeat template wrapper plus custom or unrecognized content.`,
          "Doctor left it unchanged so it does not delete user tasks. Remove the fenced template and Related lines manually if they are not intentional.",
        ].join("\n"),
        "Heartbeat template",
      );
      continue;
    }
    if (!params.shouldRepair) {
      note(
        [
          `${prefix}${shortenHomePath(heartbeatPath)} contains an older heartbeat documentation template.`,
          'Run "openclaw doctor --fix" to replace it with the clean heartbeat template.',
        ].join("\n"),
        "Heartbeat template",
      );
      continue;
    }

    try {
      const cleanTemplate = await readCleanHeartbeatTemplate();
      await writeTextAtomic(heartbeatPath, cleanTemplate, { mode: 0o600 });
      note(
        `${prefix}Replaced ${shortenHomePath(heartbeatPath)} with the clean heartbeat template.`,
        "Doctor changes",
      );
    } catch (error) {
      note(
        `${prefix}Could not repair ${shortenHomePath(heartbeatPath)}: ${formatErrorMessage(error)}`,
        "Heartbeat template",
      );
    }
  }
}
