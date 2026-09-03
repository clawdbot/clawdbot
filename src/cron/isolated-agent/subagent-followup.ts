/** Reads or waits for descendant subagent summaries after isolated cron orchestration. */
import { readLatestAssistantReply, waitForAgentRunsToDrain } from "../../agents/run-wait.js";
import { resolveSubagentCompletionResultText } from "../../agents/subagents/completion/subagent-completion-result.js";
import { listDescendantRunsForRequester } from "../../agents/subagents/registry/subagent-registry-read.js";
import { selectDeliverableSessionsReply } from "../../agents/tools/sessions-send-tokens.js";
import { stripHeartbeatToken } from "../../auto-reply/heartbeat.js";
import {
  HEARTBEAT_TOKEN,
  isSilentReplyPayloadText,
  SILENT_REPLY_TOKEN,
} from "../../auto-reply/tokens.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import { isLikelyInterimCronMessage } from "./subagent-followup-hints.js";

function resolveCronSubagentTimings() {
  const fastTestMode = isFastTestRuntimeEnv();
  return {
    waitMinMs: fastTestMode ? 10 : 30_000,
    finalReplyGraceMs: fastTestMode ? 50 : 5_000,
    gracePollMs: fastTestMode ? 8 : 200,
  };
}

/** Reads completed descendant subagent replies when the orchestrator only emitted interim text. */
export async function readDescendantSubagentFallbackReply(params: {
  sessionKey: string;
  runStartedAt: number;
}): Promise<string | undefined> {
  const descendants = listDescendantRunsForRequester(params.sessionKey)
    .filter(
      (entry) =>
        typeof entry.execution.endedAt === "number" &&
        entry.execution.endedAt >= params.runStartedAt &&
        entry.childSessionKey.trim().length > 0,
    )
    .toSorted((a, b) => (a.execution.endedAt ?? 0) - (b.execution.endedAt ?? 0));
  if (descendants.length === 0) {
    return undefined;
  }

  const latestByChild = new Map<string, (typeof descendants)[number]>();
  for (const entry of descendants) {
    const childKey = entry.childSessionKey.trim();
    if (!childKey) {
      continue;
    }
    const current = latestByChild.get(childKey);
    if (!current || (entry.execution.endedAt ?? 0) >= (current.execution.endedAt ?? 0)) {
      latestByChild.set(childKey, entry);
    }
  }

  const replies: string[] = [];
  // Limit fallback synthesis to the latest few children so a noisy run does not
  // flood the cron announce with stale descendant output.
  const latestRuns = [...latestByChild.values()]
    .toSorted((a, b) => (a.execution.endedAt ?? 0) - (b.execution.endedAt ?? 0))
    .slice(-4);
  for (const entry of latestRuns) {
    const completionReply = resolveSubagentCompletionResultText(entry);
    // Producer-owned terminal evidence and private resume transcripts must
    // never be replaced by an older visible child-session reply.
    const canReadTranscript =
      entry.completion?.terminalReply === undefined &&
      entry.execution.transcriptTarget === undefined;
    const reply = canReadTranscript
      ? selectDeliverableSessionsReply(
          await readLatestAssistantReply({ sessionKey: entry.childSessionKey }),
          completionReply,
        )
      : completionReply;
    if (!reply || reply.toUpperCase() === SILENT_REPLY_TOKEN.toUpperCase()) {
      continue;
    }
    replies.push(reply);
  }
  if (replies.length === 0) {
    return undefined;
  }
  if (replies.length === 1) {
    return replies[0];
  }
  return replies.join("\n\n");
}

/**
 * Waits for descendant subagents to complete using a push-based approach:
 * each active descendant run is awaited via `agent.wait` (gateway RPC) instead
 * of a busy-poll loop.  After all active runs settle, a short grace period
 * polls the cron agent's session for a post-orchestration synthesis message.
 */
export async function waitForDescendantSubagentSummary(params: {
  sessionKey: string;
  initialReply?: string;
  timeoutMs: number;
  observedActiveDescendants?: boolean;
}): Promise<string | undefined> {
  const timings = resolveCronSubagentTimings();
  const initialReply = params.initialReply?.trim();
  const deadline = Date.now() + Math.max(timings.waitMinMs, Math.floor(params.timeoutMs));

  // Snapshot the currently active descendant run IDs.
  const getActiveRuns = () =>
    listDescendantRunsForRequester(params.sessionKey).filter(
      (entry) => typeof entry.execution.endedAt !== "number",
    );

  const initialActiveRuns = getActiveRuns();
  const sawActiveDescendants =
    params.observedActiveDescendants === true || initialActiveRuns.length > 0;

  if (!sawActiveDescendants) {
    // No active descendants and none were observed before the call – nothing to wait for.
    return initialReply;
  }

  // Wait until no descendant runs remain active. Descendants can finish and
  // spawn more descendants, so the helper refreshes the run set until it drains.
  await waitForAgentRunsToDrain({
    deadlineAtMs: deadline,
    initialPendingRunIds: initialActiveRuns.map((entry) => entry.runId),
    getPendingRunIds: () => getActiveRuns().map((entry) => entry.runId),
  });

  // --- Grace period: wait for the cron agent's synthesis ---
  // After the subagent announces fire and the cron agent processes them, it
  // produces a new assistant message.  Poll briefly (bounded by
  // finalReplyGraceMs) to capture that synthesis.
  const gracePeriodDeadline = Math.min(Date.now() + timings.finalReplyGraceMs, deadline);

  const resolveUsableLatestReply = async () => {
    const latest = (await readLatestAssistantReply({ sessionKey: params.sessionKey }))?.trim();
    if (
      latest &&
      latest.toUpperCase() !== SILENT_REPLY_TOKEN.toUpperCase() &&
      // Parent heartbeat acknowledgments remain in chat.history after the
      // child settles and must not masquerade as descendant output.
      !stripHeartbeatToken(latest, { mode: "heartbeat", maxAckChars: 0 }).shouldSkip &&
      !isSilentReplyPayloadText(latest, HEARTBEAT_TOKEN) &&
      (latest !== initialReply || !isLikelyInterimCronMessage(latest))
    ) {
      // Ignore the original interim acknowledgement; only a new synthesis or a
      // non-interim reply should replace descendant fallback text.
      return latest;
    }
    return undefined;
  };

  while (Date.now() < gracePeriodDeadline) {
    const latest = await resolveUsableLatestReply();
    if (latest) {
      return latest;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, timings.gracePollMs);
    });
  }

  // Final read after grace period expires.
  const latest = await resolveUsableLatestReply();
  if (latest) {
    return latest;
  }

  return undefined;
}
