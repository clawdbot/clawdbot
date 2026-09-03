import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { autonomousSkillSizeError } from "../../skills/workshop/collection-contracts.js";
import {
  readProposalFrontmatter,
  resolveSkillProposalName,
  stripProposalFrontmatterForSkill,
} from "../../skills/workshop/frontmatter.js";
import { prepareSkillProposalDraft } from "../../skills/workshop/proposal-draft.js";
import {
  inspectSkillProposal,
  resolvePendingSkillProposal,
} from "../../skills/workshop/service.js";
import { PROPOSAL_DRAFT_FILE } from "../../skills/workshop/store-record.js";
import type {
  SkillProposalReadResult,
  SkillProposalRecord,
  SkillProposalStatus,
  SkillProposalSupportFileInput,
  SkillWorkshopProposalReviewCompletion,
} from "../../skills/workshop/types.js";
import { readPositiveIntegerParam, readToolStringParam, ToolInputError } from "./common.js";
import { textResult } from "./tool-results.js";

export function assertAutonomousSkillSize(
  name: string,
  description: string | undefined,
  content: string,
  currentContent: string | undefined,
  maxSkillBytes: number,
): void {
  const draft = prepareSkillProposalDraft({
    name,
    description: description ?? readProposalFrontmatter(currentContent ?? "")?.description ?? name,
    content,
    fallbackFrontmatterContent: currentContent,
    date: new Date().toISOString(),
    maxSkillBytes,
  });
  if (!draft.ok) {
    throw draft.error.cause;
  }
  const resultChars = stripProposalFrontmatterForSkill(draft.value.content).length;
  const sizeError = autonomousSkillSizeError(name, currentContent?.length ?? 0, resultChars);
  if (sizeError) {
    throw new ToolInputError(sizeError);
  }
}

export function skillWorkshopAgentEventActor(agentId?: string) {
  return { type: "agent" as const, ...(agentId ? { id: agentId } : {}) };
}

export function proposalReviewPhase(
  completion: SkillWorkshopProposalReviewCompletion,
): "open" | "completing" | "completed" {
  return completion.phase ?? (completion.completed ? "completed" : "open");
}

export function beginProposalReviewMutation(
  completion: SkillWorkshopProposalReviewCompletion | undefined,
): (() => void) | undefined {
  if (!completion) {
    return undefined;
  }
  if (proposalReviewPhase(completion) !== "open") {
    throw new ToolInputError("this Skill Workshop review is already completing or complete");
  }
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const activeMutations = completion.activeMutations ?? new Set<Promise<void>>();
  completion.activeMutations = activeMutations;
  activeMutations.add(done);
  return () => {
    activeMutations.delete(done);
    release();
  };
}

export async function completeProposalReview(completion: SkillWorkshopProposalReviewCompletion) {
  const phase = proposalReviewPhase(completion);
  if (phase === "completed") {
    return completionResult();
  }
  if (phase === "completing") {
    throw new ToolInputError("this Skill Workshop review is already completing");
  }
  completion.phase = "completing";
  try {
    await Promise.all(Array.from(completion.activeMutations ?? []));
    await completion.complete();
    completion.completed = true;
    completion.phase = "completed";
    return completionResult();
  } catch (error) {
    completion.phase = "open";
    throw error;
  }
}

function completionResult() {
  return textResult("Completed Skill Workshop review.", { completed: true });
}

export function proposalMutationText(action: string, record: SkillProposalRecord): string {
  return `${action} ${record.id} (${record.status}) for ${resolveSkillProposalName(record.kind, record.target)}.`;
}

export function actionResult(
  record: SkillProposalRecord,
  options: { contentText: string; targetSkillFile?: string },
) {
  return textResult(options.contentText, {
    id: record.id,
    status: record.status,
    kind: record.kind,
    skillName: record.target.skillName,
    skillKey: record.target.skillKey,
    targetSkillFile: options.targetSkillFile ?? record.target.skillFile,
    scanState: record.scan.state,
    proposedVersion: record.proposedVersion,
    draftHash: record.draftHash,
  });
}

export function proposalResult(
  proposal: SkillProposalReadResult,
  options: {
    contentText?: string;
    inspect?: {
      artifactPath: string;
      artifactSizeBytes: number;
      availableArtifacts: Array<{ path: string; sizeBytes: number }>;
      contentIncluded: boolean;
    };
  } = {},
) {
  return {
    content: options.contentText ? [{ type: "text" as const, text: options.contentText }] : [],
    details: {
      id: proposal.record.id,
      status: proposal.record.status,
      kind: proposal.record.kind,
      skillName: proposal.record.target.skillName,
      skillKey: proposal.record.target.skillKey,
      proposalFile: PROPOSAL_DRAFT_FILE,
      supportFileCount: proposal.record.supportFiles?.length ?? 0,
      targetSkillFile: proposal.record.target.skillFile,
      scanState: proposal.record.scan.state,
      proposedVersion: proposal.record.proposedVersion,
      draftHash: proposal.record.draftHash,
      revisionHash: proposal.revisionHash,
      ...(proposal.record.evaluation ? { evaluation: proposal.record.evaluation } : {}),
      ...(options.inspect ? { inspect: options.inspect } : {}),
    },
  };
}

export function readLifecycleProposalIdParam(params: Record<string, unknown>): string {
  return readToolStringParam(params, "proposal_id", {
    required: true,
    label: "proposal_id",
  });
}

export async function readProposalForInspect(
  params: Record<string, unknown>,
  workspaceDir: string,
  config?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  agentId?: string,
): Promise<SkillProposalReadResult> {
  const proposalId = readToolStringParam(params, "proposal_id", { label: "proposal_id" });
  if (proposalId) {
    const proposal = await inspectSkillProposal(proposalId, { agentId, config, env });
    if (!proposal) {
      throw new ToolInputError(`Skill proposal not found: ${proposalId}`);
    }
    return proposal;
  }
  const resolved = await resolvePendingSkillProposal({
    name: readToolStringParam(params, "name", { required: true }),
    workspaceDir,
    config,
    env,
    agentId,
  });
  const proposal = await inspectSkillProposal(resolved.record.id, {
    agentId,
    config,
    env,
  });
  if (!proposal) {
    throw new ToolInputError(`Skill proposal not found: ${resolved.record.id}`);
  }
  return proposal;
}

export function readProposalStatusParam(
  params: Record<string, unknown>,
  statuses: readonly SkillProposalStatus[],
): SkillProposalStatus | undefined {
  const status = readToolStringParam(params, "status");
  if (!status) {
    return undefined;
  }
  if (!(statuses as readonly string[]).includes(status)) {
    throw new ToolInputError(`status must be one of ${statuses.join(", ")}`);
  }
  return status as SkillProposalStatus;
}

export function readListLimitParam(params: Record<string, unknown>): number {
  return readPositiveIntegerParam(params, "limit") ?? 20;
}

export function readSupportFilesParam(
  params: Record<string, unknown>,
): SkillProposalSupportFileInput[] | undefined {
  const raw = params.support_files;
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new ToolInputError("support_files must be an array");
  }
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ToolInputError(`support_files[${index}] must be an object`);
    }
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || !file.path.trim()) {
      throw new ToolInputError(`support_files[${index}].path required`);
    }
    if (typeof file.content !== "string") {
      throw new ToolInputError(`support_files[${index}].content required`);
    }
    return { path: file.path, content: file.content };
  });
}
