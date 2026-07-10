// Workshop policy helpers validate generated skill drafts against workspace policy.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH } from "../../infra/plugin-approvals.js";
import type { PluginHookBeforeToolCallResult } from "../../plugins/hook-before-tool-call-result.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { resolvePendingSkillProposal } from "./service.js";

const SKILL_WORKSHOP_LIFECYCLE_ACTIONS = new Set(["apply", "reject", "quarantine"]);
// Codex dynamic tools have a 90s watchdog. Approval RPCs reserve another 10s
// for Gateway cleanup, leaving 10s for proposal lookup and tool-call overhead.
const SKILL_WORKSHOP_APPROVAL_TIMEOUT_MS = 70_000;

type SkillWorkshopLifecycleAction = "apply" | "reject" | "quarantine";

// Only lifecycle actions mutate proposals and therefore require approval checks.
function readLifecycleAction(params: unknown): SkillWorkshopLifecycleAction | undefined {
  const action = asNullableRecord(params)?.action;
  if (typeof action !== "string" || !SKILL_WORKSHOP_LIFECYCLE_ACTIONS.has(action)) {
    return undefined;
  }
  return action as SkillWorkshopLifecycleAction;
}

function lifecycleApprovalText(action: SkillWorkshopLifecycleAction): {
  title: string;
  description: string;
  severity: "info" | "warning";
} {
  if (action === "apply") {
    return {
      title: "Apply workspace skill proposal",
      description: "Apply a pending workspace skill proposal into live workspace skills.",
      severity: "warning",
    };
  }
  if (action === "reject") {
    return {
      title: "Reject workspace skill proposal",
      description: "Reject a pending workspace skill proposal.",
      severity: "info",
    };
  }
  return {
    title: "Quarantine workspace skill proposal",
    description: "Quarantine a pending workspace skill proposal.",
    severity: "info",
  };
}

function readOptionalString(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatBodySizeKb(content: string): string {
  return (Buffer.byteLength(content, "utf8") / 1024).toFixed(1);
}

function formatApprovalField(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
    character === "\n" || character === "\r" || character === "\u2028" || character === "\u2029"
      ? "↵"
      : "�",
  );
}

function buildLifecycleApprovalDescription(params: {
  proposalId: string;
  skillName: string;
  description: string;
  supportFileCount: number;
  bodySizeKb: string;
}): string {
  const description = formatApprovalField(params.description);
  const requestedSkillName = formatApprovalField(params.skillName);
  const fixedLines = [
    `Proposal ID: ${params.proposalId}`,
    `Description: ${description}`,
    `Support files: ${params.supportFileCount}`,
    `Body size: ${params.bodySizeKb} KB`,
  ];
  const skillPrefix = "Target skill: ";
  const fixedLength = fixedLines.join("\n").length + skillPrefix.length + fixedLines.length;
  const availableSkillNameLength = Math.max(
    1,
    PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH - fixedLength,
  );
  const skillName =
    requestedSkillName.length <= availableSkillNameLength
      ? requestedSkillName
      : `${truncateUtf16Safe(requestedSkillName, Math.max(0, availableSkillNameLength - 1))}…`;
  return [fixedLines[0], `${skillPrefix}${skillName}`, ...fixedLines.slice(1)].join("\n");
}

async function resolveLifecycleApprovalDescription(params: {
  toolParams: unknown;
  workspaceDir?: string;
  fallback: string;
}): Promise<{
  description: string;
  proposalId?: string;
}> {
  if (!params.workspaceDir) {
    return { description: params.fallback };
  }
  const toolParams = asNullableRecord(params.toolParams);
  try {
    const proposal = await resolvePendingSkillProposal({
      proposalId: readOptionalString(toolParams, "proposal_id"),
      name: readOptionalString(toolParams, "name"),
      workspaceDir: params.workspaceDir,
    });
    const record = proposal.record;
    return {
      description: buildLifecycleApprovalDescription({
        proposalId: record.id,
        skillName: record.target.skillName,
        description: record.description,
        supportFileCount: record.supportFiles?.length ?? 0,
        bodySizeKb: formatBodySizeKb(proposal.content),
      }),
      proposalId: record.id,
    };
  } catch {
    return { description: params.fallback };
  }
}

function lifecycleApprovalTimeoutReason(proposalId?: string): string {
  const proposal = proposalId ? `Proposal ${proposalId}` : "the proposal";
  return [
    "The Skill Workshop approval request expired without a decision.",
    `This lifecycle call left ${proposal} unchanged and pending; check its current status in case another operator acted on it.`,
    "Decide in the Skill Workshop UI or run `openclaw skills workshop apply|reject|quarantine <id>`.",
    "Do not retry this tool call in a loop.",
  ].join(" ");
}

function resolveApprovalConfig(config?: OpenClawConfig): OpenClawConfig | undefined {
  if (config) {
    return config;
  }
  // Explicit hook config wins. Missing hook config may happen on agent paths;
  // unreadable runtime config keeps the default pending approval gate.
  try {
    return getRuntimeConfig();
  } catch {
    return undefined;
  }
}

/** Returns approval policy for skill workshop lifecycle tool calls. */
export async function resolveSkillWorkshopToolApproval(params: {
  toolName: string;
  toolParams: unknown;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): Promise<PluginHookBeforeToolCallResult | undefined> {
  if (params.toolName !== "skill_workshop") {
    return undefined;
  }
  const action = readLifecycleAction(params.toolParams);
  if (!action) {
    return undefined;
  }
  const config = resolveSkillWorkshopConfig(resolveApprovalConfig(params.config));
  if (config.approvalPolicy === "auto") {
    return undefined;
  }
  const text = lifecycleApprovalText(action);
  const approvalDescription = await resolveLifecycleApprovalDescription({
    toolParams: params.toolParams,
    workspaceDir: params.workspaceDir,
    fallback: text.description,
  });
  return {
    requireApproval: {
      ...text,
      description: approvalDescription.description,
      timeoutMs: SKILL_WORKSHOP_APPROVAL_TIMEOUT_MS,
      timeoutReason: lifecycleApprovalTimeoutReason(approvalDescription.proposalId),
      allowedDecisions: ["allow-once", "deny"],
    },
  };
}
