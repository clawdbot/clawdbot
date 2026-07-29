import { randomUUID } from "node:crypto";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PluginHookSkillProposalEvaluateEvent,
  PluginHookSkillProposalEvaluationOutcome,
} from "../../plugins/hook-types.js";
import { hashSkillProposalRevision } from "./revision-hash.js";
import type { NewSkillProposalEvent } from "./store-sqlite-event.js";
import type {
  SkillProposalEvent,
  SkillProposalEventActor,
  SkillProposalEventType,
  SkillProposalRecord,
} from "./types.js";

export function createSkillProposalEvent(params: {
  record: SkillProposalRecord;
  type: SkillProposalEventType;
  actor?: SkillProposalEventActor;
  correlationId?: string;
  occurredAt?: string;
  payload?: NewSkillProposalEvent["payload"];
}): NewSkillProposalEvent {
  return {
    eventId: randomUUID(),
    proposalId: params.record.id,
    proposedVersion: params.record.proposedVersion,
    revisionHash: hashSkillProposalRevision(params.record),
    type: params.type,
    occurredAt: params.occurredAt ?? new Date().toISOString(),
    actor: params.actor ?? { type: "system" },
    ...(params.correlationId ? { correlationId: params.correlationId } : {}),
    ...(params.payload ? { payload: params.payload } : {}),
  };
}

export async function runSkillProposalEvaluators(
  event: PluginHookSkillProposalEvaluateEvent,
  ctx: { workspaceDir: string; agentId?: string },
): Promise<PluginHookSkillProposalEvaluationOutcome[]> {
  const runner = getGlobalHookRunner();
  if (!runner?.hasHooks("skill_proposal_evaluate")) {
    return [];
  }
  return await runner.runSkillProposalEvaluate(event, ctx);
}

export async function dispatchSkillProposalChanged(params: {
  event: SkillProposalEvent;
  record: SkillProposalRecord;
  workspaceDir: string;
  agentId?: string;
  evaluations?: PluginHookSkillProposalEvaluationOutcome[];
}): Promise<void> {
  const runner = getGlobalHookRunner();
  if (!runner?.hasHooks("skill_proposal_changed")) {
    return;
  }
  await runner.runSkillProposalChanged(
    {
      eventId: params.event.eventId,
      sequence: params.event.sequence,
      action: params.event.type,
      occurredAt: params.event.occurredAt,
      ...(params.event.correlationId ? { correlationId: params.event.correlationId } : {}),
      proposal: {
        id: params.record.id,
        kind: params.record.kind,
        status: params.record.status,
        revision: params.record.proposedVersion,
        revisionSha256: params.event.revisionHash,
        skillName: params.record.target.skillName,
        skillKey: params.record.target.skillKey,
        skillFile: params.record.target.skillFile,
        ...(params.record.target.source ? { source: params.record.target.source } : {}),
      },
      ...(params.evaluations ? { evaluations: params.evaluations } : {}),
    },
    {
      workspaceDir: params.workspaceDir,
      ...(params.agentId ? { agentId: params.agentId } : {}),
    },
  );
}
