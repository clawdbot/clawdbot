import type { RunEmbeddedAgentParams } from "./params.js";

export function resolveSkillWorkshopAttemptParams(
  params: Pick<
    RunEmbeddedAgentParams,
    | "skillWorkshopOrigin"
    | "skillWorkshopProposalEnv"
    | "skillWorkshopProposalMutationBudget"
    | "skillWorkshopProposalOnly"
    | "skillWorkshopProposalReviewCompletion"
  >,
) {
  return {
    skillWorkshopProposalOnly: params.skillWorkshopProposalOnly,
    skillWorkshopProposalEnv: params.skillWorkshopProposalEnv,
    skillWorkshopOrigin: params.skillWorkshopOrigin,
    skillWorkshopProposalMutationBudget: params.skillWorkshopProposalMutationBudget,
    skillWorkshopProposalReviewCompletion: params.skillWorkshopProposalReviewCompletion,
  };
}
