import { createHash } from "node:crypto";
import type {
  PluginHookSkillContext,
  PluginHookSkillProposalChangedEvent,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "../api.js";
import type { WorkboardStore } from "./store.js";

const SKILL_PROPOSAL_FOLLOWUP_PREFIX = "skill-workshop-proposal-v1";
const OBSERVED_PENDING_ACTIONS = new Set<PluginHookSkillProposalChangedEvent["action"]>([
  "created",
  "revised",
  "evaluation_completed",
]);

type SkillProposalObserverStore = Pick<WorkboardStore, "create">;
export type WorkboardSkillProposalFollowup = Pick<
  PluginHookSkillProposalChangedEvent["proposal"],
  "id" | "kind" | "status" | "skillName" | "source"
>;
type SkillProposalChangedHandler = (
  event: PluginHookSkillProposalChangedEvent,
  ctx: PluginHookSkillContext,
) => Promise<void>;

function buildSkillProposalFollowupIdempotencyKey(proposalId: string): string {
  const digest = createHash("sha256").update(proposalId).digest("hex").slice(0, 32);
  return `${SKILL_PROPOSAL_FOLLOWUP_PREFIX}:${digest}`;
}

function buildSkillProposalFollowupNotes(proposal: WorkboardSkillProposalFollowup): string {
  const source = proposal.source?.trim();
  return [
    "A committed Skill Workshop proposal is pending operator review.",
    `Proposal: ${proposal.id}`,
    `Kind: ${proposal.kind}`,
    ...(source ? [`Source: ${source}`] : []),
    "Approval boundary: this card does not apply, publish, reject, or modify the skill.",
  ].join("\n");
}

export async function captureWorkboardSkillProposalFollowup(params: {
  proposal: WorkboardSkillProposalFollowup;
  agentId?: string;
  store: SkillProposalObserverStore;
}): Promise<{ cardId: string } | undefined> {
  if (params.proposal.status !== "pending") {
    return undefined;
  }
  const card = await params.store.create({
    title: `Review proposed skill: ${params.proposal.skillName}`,
    notes: buildSkillProposalFollowupNotes(params.proposal),
    status: "todo",
    labels: ["skill-workshop", "proposal-review"],
    ...(params.agentId ? { agentId: params.agentId } : {}),
    idempotencyKey: buildSkillProposalFollowupIdempotencyKey(params.proposal.id),
  });
  return { cardId: card.id };
}

export function createWorkboardSkillProposalHandler(params: {
  api: Pick<OpenClawPluginApi, "logger">;
  store: SkillProposalObserverStore;
}): SkillProposalChangedHandler {
  return async (event, ctx) => {
    try {
      if (!OBSERVED_PENDING_ACTIONS.has(event.action)) {
        return;
      }
      const captured = await captureWorkboardSkillProposalFollowup({
        proposal: event.proposal,
        agentId: ctx.agentId,
        store: params.store,
      });
      if (captured) {
        params.api.logger.info?.(
          `workboard: ensured skill proposal follow-up event=${event.eventId} card=${captured.cardId}`,
        );
      }
    } catch (error) {
      const errorKind = error instanceof Error ? error.name : "UnknownError";
      params.api.logger.warn?.(
        `workboard: skill proposal follow-up failed event=${event.eventId} error=${errorKind}`,
      );
    }
  };
}
