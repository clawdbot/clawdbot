import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { DelegateArtifactRecipientProjectionV1 } from "./delegate-artifacts.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "./internal-events.js";
import type { SubagentRunOutcome } from "./subagents/announce/subagent-run-outcome.js";
export type SubagentAnnounceType = "subagent task" | "cron job";

function buildAnnounceReplyInstruction(params: {
  requesterIsSubagent: boolean;
  announceType: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
}): string {
  if (params.requesterIsSubagent) {
    return `Convert this completion into a concise internal orchestration update for your parent agent in your own words. Keep this internal context private (don't mention system/log/stats/session details or announce type). If this result is duplicate or no update is needed, reply ONLY: ${SILENT_REPLY_TOKEN}.`;
  }
  if (params.expectsCompletionMessage) {
    return `A completed ${params.announceType} is ready for parent review. Review/verify the result above before deciding whether the original task is done. If additional action is required, continue the task or record a follow-up; otherwise send a truthful user-facing update. Keep this internal context private (don't mention system/log/stats/session details or announce type). Reply ONLY: ${SILENT_REPLY_TOKEN} only when this exact result is already visible to the user in this same turn.`;
  }
  return `A completed ${params.announceType} is ready for parent review. Review/verify the result above before deciding whether the original task is done. If additional action is required, continue the task or record a follow-up; otherwise send a truthful user-facing update. Keep this internal context private (don't mention system/log/stats/session details or announce type), and do not copy the internal event text verbatim. Reply ONLY: ${SILENT_REPLY_TOKEN} if this exact result was already delivered to the user in this same turn.`;
}

function buildAnnounceSteerMessage(events: AgentInternalEvent[]): string {
  return (
    formatAgentInternalEventsForPrompt(events) ||
    "A background task finished. Process the completion update now."
  );
}

export function buildSubagentAnnounceMessages(params: {
  requesterIsSubagent: boolean;
  announceType: SubagentAnnounceType;
  expectsCompletionMessage: boolean;
  childSessionKey: string;
  childSessionId: string;
  requesterSessionKey: string;
  taskLabel: string;
  outcome: SubagentRunOutcome;
  findings: string;
  statsLine?: string;
  artifactProjections?: Map<string, DelegateArtifactRecipientProjectionV1>;
}): {
  internalEvents: AgentInternalEvent[];
  triggerMessage: string;
  artifactTriggerMessages?: Map<string, string>;
} {
  const statusLabel =
    params.outcome.status === "ok"
      ? "completed; ready for parent review"
      : params.outcome.status === "timeout"
        ? params.outcome.error
          ? `timed out: ${params.outcome.error}`
          : "timed out"
        : params.outcome.status === "error"
          ? `failed: ${params.outcome.error || "unknown error"}`
          : "finished with unknown status";
  const replyInstruction = buildAnnounceReplyInstruction(params);
  const baseInternalEvent: AgentInternalEvent = {
    type: "task_completion",
    source: params.announceType === "cron job" ? "cron" : "subagent",
    childSessionKey: params.childSessionKey,
    childSessionId: params.childSessionId,
    announceType: params.announceType,
    taskLabel: params.taskLabel,
    status: params.outcome.status,
    statusLabel,
    result: params.findings,
    statsLine: params.statsLine,
    replyInstruction,
  };
  const requesterProjection = params.artifactProjections?.get(params.requesterSessionKey);
  const internalEvents: AgentInternalEvent[] = [
    requesterProjection
      ? { ...baseInternalEvent, delegateArtifacts: requesterProjection }
      : baseInternalEvent,
  ];
  const triggerMessage = buildAnnounceSteerMessage(internalEvents);
  const artifactTriggerMessages = params.artifactProjections
    ? new Map(
        [...params.artifactProjections].map(([sessionKey, projection]) => [
          sessionKey,
          buildAnnounceSteerMessage([{ ...baseInternalEvent, delegateArtifacts: projection }]),
        ]),
      )
    : undefined;
  return { internalEvents, triggerMessage, artifactTriggerMessages };
}
