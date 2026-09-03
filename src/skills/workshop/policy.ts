import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH } from "../../infra/plugin-approvals.js";
import { logDebug } from "../../logger.js";
import type { PluginHookBeforeToolCallResult } from "../../plugins/hook-before-tool-call-result.js";
import { createLazyRuntimeNamedExport } from "../../shared/lazy-runtime.js";
import { resolveSkillWorkshopConfig } from "./config.js";

// Proposal reconciliation and skill-install dependencies belong to actual approval-detail lookup.
const loadPendingSkillProposalResolver = createLazyRuntimeNamedExport(
  () => import("./policy.runtime.js"),
  "resolvePendingSkillProposal",
);

const SKILL_WORKSHOP_LIFECYCLE_ACTIONS = new Set([
  "apply",
  "reject",
  "quarantine",
  "restore_collection",
]);
// Codex dynamic tools have a 90s watchdog. Approval RPCs reserve another 10s
// for Gateway cleanup, leaving 10s for proposal lookup and tool-call overhead.
const SKILL_WORKSHOP_APPROVAL_TIMEOUT_MS = 70_000;

type SkillWorkshopLifecycleAction = "apply" | "reject" | "quarantine" | "restore_collection";

// Lifecycle actions mutate proposals or live skills and therefore require approval checks.
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
      title: "Apply Skill Workshop proposal",
      description: "Apply a pending proposal inside your agent's Workshop directory.",
      severity: "warning",
    };
  }
  if (action === "reject") {
    return {
      title: "Reject Skill Workshop proposal",
      description: "Reject a pending Skill Workshop proposal.",
      severity: "info",
    };
  }
  if (action === "restore_collection") {
    return {
      title: "Restore previous skill collection",
      description:
        "Replace current Workshop-generated skills with the previous collection backup. Later Workshop changes may be removed.",
      severity: "warning",
    };
  }
  return {
    title: "Quarantine Skill Workshop proposal",
    description: "Quarantine a pending Skill Workshop proposal.",
    severity: "info",
  };
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
  config: OpenClawConfig;
  agentId?: string;
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
    const resolvePendingSkillProposal = await loadPendingSkillProposalResolver();
    const proposal = await resolvePendingSkillProposal({
      proposalId: normalizeOptionalString(toolParams?.proposal_id),
      name: normalizeOptionalString(toolParams?.name),
      workspaceDir: params.workspaceDir,
      config: params.config,
      agentId: params.agentId,
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
  } catch (error) {
    // Approving blind is the failure this record exists to make diagnosable:
    // the card otherwise looks identical to "there is no more detail".
    logDebug(
      `skill-workshop: approval detail unavailable, using generic text: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { description: params.fallback };
  }
}

function lifecycleApprovalTimeoutReason(params: {
  action: SkillWorkshopLifecycleAction;
  proposalId?: string;
}): string {
  if (params.action === "restore_collection") {
    return [
      "The Skill Workshop approval request expired without a decision.",
      "This restore call left Workshop-generated skills unchanged.",
      "Review the current skills, then request the restore again if it is still wanted.",
      "Do not retry this tool call in a loop.",
    ].join(" ");
  }
  const proposal = params.proposalId ? `Proposal ${params.proposalId}` : "the proposal";
  return [
    "The Skill Workshop approval request expired without a decision.",
    `This lifecycle call left ${proposal} unchanged and pending; check its current status in case another operator acted on it.`,
    "Decide in the Skill Workshop UI or run `openclaw skills workshop apply|reject|quarantine <id>`.",
    "Do not retry this tool call in a loop.",
  ].join(" ");
}

/** Returns approval policy for skill workshop lifecycle tool calls. */
export async function resolveSkillWorkshopToolApproval(params: {
  toolName: string;
  toolParams: unknown;
  config: OpenClawConfig;
  workspaceDir?: string;
  agentId?: string;
}): Promise<PluginHookBeforeToolCallResult | undefined> {
  if (params.toolName !== "skill_workshop") {
    return undefined;
  }
  const action = readLifecycleAction(params.toolParams);
  if (!action) {
    return undefined;
  }
  const config = resolveSkillWorkshopConfig(params.config);
  if (config.approvalPolicy === "auto") {
    return undefined;
  }
  const text = lifecycleApprovalText(action);
  const approvalDescription =
    action === "restore_collection"
      ? { description: text.description }
      : await resolveLifecycleApprovalDescription({
          toolParams: params.toolParams,
          workspaceDir: params.workspaceDir,
          config: params.config,
          agentId: params.agentId,
          fallback: text.description,
        });
  return {
    requireApproval: {
      ...text,
      description: approvalDescription.description,
      timeoutMs: SKILL_WORKSHOP_APPROVAL_TIMEOUT_MS,
      timeoutReason: lifecycleApprovalTimeoutReason({
        action,
        proposalId: approvalDescription.proposalId,
      }),
      allowedDecisions: ["allow-once", "deny"],
    },
  };
}
