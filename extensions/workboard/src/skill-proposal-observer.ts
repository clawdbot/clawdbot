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
type SkillProposalChangedHandler = (
  event: PluginHookSkillProposalChangedEvent,
  ctx: PluginHookSkillContext,
) => Promise<void>;

function buildSkillProposalFollowupIdempotencyKey(proposalId: string): string {
  const digest = createHash("sha256").update(proposalId).digest("hex").slice(0, 32);
  return `${SKILL_PROPOSAL_FOLLOWUP_PREFIX}:${digest}`;
}

function buildSkillProposalFollowupNotes(event: PluginHookSkillProposalChangedEvent): string {
  const source = event.proposal.source?.trim();
  return [
    "A committed Skill Workshop proposal is pending operator review.",
    `Proposal: ${event.proposal.id}`,
    `Kind: ${event.proposal.kind}`,
    ...(source ? [`Source: ${source}`] : []),
    "Approval boundary: this card does not apply, publish, reject, or modify the skill.",
  ].join("\n");
}

async function captureSkillProposalFollowup(params: {
  event: PluginHookSkillProposalChangedEvent;
  ctx: PluginHookSkillContext;
  store: SkillProposalObserverStore;
}): Promise<{ cardId: string } | undefined> {
  if (
    params.event.proposal.status !== "pending" ||
    !OBSERVED_PENDING_ACTIONS.has(params.event.action)
  ) {
    return undefined;
  }
  const card = await params.store.create({
    title: `Review proposed skill: ${params.event.proposal.skillName}`,
    notes: buildSkillProposalFollowupNotes(params.event),
    status: "todo",
    labels: ["skill-workshop", "proposal-review"],
    ...(params.ctx.agentId ? { agentId: params.ctx.agentId } : {}),
    idempotencyKey: buildSkillProposalFollowupIdempotencyKey(params.event.proposal.id),
  });
  return { cardId: card.id };
}

export function createWorkboardSkillProposalHandler(params: {
  api: Pick<OpenClawPluginApi, "logger">;
  store: SkillProposalObserverStore;
}): SkillProposalChangedHandler {
  return async (event, ctx) => {
    try {
      const captured = await captureSkillProposalFollowup({ event, ctx, store: params.store });
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
