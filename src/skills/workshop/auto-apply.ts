import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { skillProposalApplyAbortSignal } from "./apply-transition.js";
import { applySkillProposal } from "./service.js";
import type { SkillProposalActionInput, SkillProposalApplyResult } from "./types.js";

const log = createSubsystemLogger("skills/workshop");

type AutoApplyDeps = {
  apply: typeof applySkillProposal;
};

const defaultDeps: AutoApplyDeps = { apply: applySkillProposal };

/** Applies one capture through the normal Workshop service without retrying failures. */
export async function autoApplySkillProposal(
  params: {
    workspaceDir: string;
    agentId?: string;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    proposalId: string;
    skillName: string;
    abortSignal?: AbortSignal;
  },
  deps: AutoApplyDeps = defaultDeps,
): Promise<SkillProposalApplyResult | undefined> {
  try {
    // Reviewers stay proposal-only; the normal apply scanner remains the safety boundary.
    // Approval-free miscaptures stay recoverable through rejection or curator lifecycle controls.
    const input: SkillProposalActionInput & {
      [skillProposalApplyAbortSignal]?: AbortSignal;
    } = {
      workspaceDir: params.workspaceDir,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.config ? { config: params.config } : {}),
      ...(params.env ? { env: params.env } : {}),
      proposalId: params.proposalId,
      reason: "Autonomous self-learning capture",
      ...(params.abortSignal ? { [skillProposalApplyAbortSignal]: params.abortSignal } : {}),
    };
    const applied = await deps.apply(input);
    log.info(`auto-applied skill ${params.skillName} from proposal ${params.proposalId}`);
    return applied;
  } catch (error) {
    log.warn(
      `auto-apply left skill ${params.skillName} proposal ${params.proposalId} unapplied: ${String(error)}`,
    );
    return undefined;
  }
}
