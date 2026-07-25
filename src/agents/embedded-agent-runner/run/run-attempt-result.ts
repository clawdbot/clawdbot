import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasOutboundDeliveryEvidence } from "../delivery-evidence.js";
import type { ToolSummaryTrace } from "../types.js";
import { runEmbeddedAttemptWithBackend } from "./backend.js";
import { resolveAttemptReplayMetadata } from "./incomplete-turn.js";

type EmbeddedRunAttemptForRunner = Awaited<ReturnType<typeof runEmbeddedAttemptWithBackend>>;

export function normalizeEmbeddedRunAttemptResult(
  attempt: EmbeddedRunAttemptForRunner,
): EmbeddedRunAttemptForRunner {
  const raw = attempt as EmbeddedRunAttemptForRunner & {
    assistantTexts?: EmbeddedRunAttemptForRunner["assistantTexts"] | null;
    toolMetas?: EmbeddedRunAttemptForRunner["toolMetas"] | null;
    acceptedSessionSpawns?: EmbeddedRunAttemptForRunner["acceptedSessionSpawns"] | null;
    messagesSnapshot?: EmbeddedRunAttemptForRunner["messagesSnapshot"] | null;
    messagingToolSentTexts?: EmbeddedRunAttemptForRunner["messagingToolSentTexts"] | null;
    messagingToolSentMediaUrls?: EmbeddedRunAttemptForRunner["messagingToolSentMediaUrls"] | null;
    messagingToolSentTargets?: EmbeddedRunAttemptForRunner["messagingToolSentTargets"] | null;
    messagingToolSourceReplyPayloads?:
      | EmbeddedRunAttemptForRunner["messagingToolSourceReplyPayloads"]
      | null;
    didDeliverSourceReplyViaMessageTool?: boolean | null;
    itemLifecycle?: EmbeddedRunAttemptForRunner["itemLifecycle"] | null;
    currentAttemptReplayMetadata?:
      | EmbeddedRunAttemptForRunner["currentAttemptReplayMetadata"]
      | null;
  };
  return {
    ...attempt,
    assistantTexts: raw.assistantTexts ?? [],
    toolMetas: raw.toolMetas ?? [],
    acceptedSessionSpawns: raw.acceptedSessionSpawns ?? [],
    messagesSnapshot: raw.messagesSnapshot ?? [],
    messagingToolSentTexts: raw.messagingToolSentTexts ?? [],
    messagingToolSentMediaUrls: raw.messagingToolSentMediaUrls ?? [],
    messagingToolSentTargets: raw.messagingToolSentTargets ?? [],
    messagingToolSourceReplyPayloads: raw.messagingToolSourceReplyPayloads ?? [],
    didDeliverSourceReplyViaMessageTool: raw.didDeliverSourceReplyViaMessageTool === true,
    itemLifecycle: raw.itemLifecycle ?? {
      startedCount: 0,
      completedCount: 0,
      activeCount: 0,
    },
    replayMetadata: resolveAttemptReplayMetadata(raw),
    currentAttemptReplayMetadata: raw.currentAttemptReplayMetadata ?? undefined,
  };
}

export function hasCompletedModelProgressForIdleBreaker(
  attempt: EmbeddedRunAttemptForRunner,
): boolean {
  return (
    attempt.assistantTexts.some((text) => text.trim().length > 0) ||
    attempt.toolMetas.length > 0 ||
    (attempt.clientToolCalls?.length ?? 0) > 0 ||
    hasOutboundDeliveryEvidence(attempt) ||
    attempt.itemLifecycle.completedCount > 0
  );
}

export function buildTraceToolSummary(params: {
  toolMetas?: EmbeddedRunAttemptForRunner["toolMetas"];
  fallbackHadFailure: boolean;
}): ToolSummaryTrace | undefined {
  if (!params.toolMetas?.length) {
    return undefined;
  }
  const tools: string[] = [];
  const seen = new Set<string>();
  for (const entry of params.toolMetas) {
    const toolName = normalizeOptionalString(entry.toolName);
    if (!toolName || seen.has(toolName)) {
      continue;
    }
    seen.add(toolName);
    tools.push(toolName);
  }
  const failedToolCalls = params.toolMetas.filter((entry) => entry.isError === true).length;
  return {
    calls: params.toolMetas.length,
    tools,
    // Per-call error metadata is additive to the shipped harness result contract.
    // Keep the prior any-failure signal for external harnesses that do not emit it yet.
    failures: failedToolCalls || Number(params.fallbackHadFailure),
  };
}
