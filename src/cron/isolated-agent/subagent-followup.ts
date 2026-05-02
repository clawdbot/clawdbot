import { readLatestAssistantReply, waitForAgentRunsToDrain } from "../../agents/run-wait.js";
import { listDescendantRunsForRequester } from "../../agents/subagent-registry-read.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { isLikelyInterimCronMessage } from "./subagent-followup-hints.js";

function resolveCronSubagentTimings() {
  const fastTestMode = process.env.OPENCLAW_TEST_FAST === "1";
  return {
    waitMinMs: fastTestMode ? 10 : 30_000,
    finalReplyGraceMs: fastTestMode ? 50 : 5_000,
    gracePollMs: fastTestMode ? 8 : 200,
  };
}

export async function readDescendantSubagentFallbackReply(params: {
  sessionKey: string;
  runStartedAt: number;
}): Promise<string | undefined> {
  const descendants = listDescendantRunsForRequester(params.sessionKey)
    .filter(
      (entry) =>
        typeof entry.endedAt === "number" &&
        entry.endedAt >= params.runStartedAt &&
        entry.childSessionKey.trim().length > 0,
    )
    .toSorted((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
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
    if (!current || (entry.endedAt ?? 0) >= (current.endedAt ?? 0)) {
      latestByChild.set(childKey, entry);
    }
  }

  const replies: string[] = [];
  const latestRuns = [...latestByChild.values()]
    .toSorted((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
    .slice(-4);
  for (const entry of latestRuns) {
    let reply = (await readLatestAssistantReply({ sessionKey: entry.childSessionKey }))?.trim();
    // Fall back to the registry's frozen result text when the session transcript
    // is unavailable (e.g. child session already deleted by announce cleanup).
    if (!reply && typeof entry.frozenResultText === "string" && entry.frozenResultText.trim()) {
      reply = entry.frozenResultText.trim();
    }
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
      (entry) => typeof entry.endedAt !== "number",
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
      (latest !== initialReply || !isLikelyInterimCronMessage(latest))
    ) {
      return latest;
    }
    return undefined;
  };

  while (Date.now() < gracePeriodDeadline) {
    const latest = await resolveUsableLatestReply();
    if (latest) {
      return latest;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, timings.gracePollMs));
  }

  // Final read after grace period expires.
  const latest = await resolveUsableLatestReply();
  if (latest) {
    return latest;
  }

  return undefined;
}
