import {
  embeddedAgentLog,
  formatErrorMessage,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  publishSessionTranscriptUpdateByIdentity,
} from "openclaw/plugin-sdk/session-transcript-runtime";

const CONTEXT_COMPACTION_CUSTOM_TYPE = "openclaw.context-compaction";

/**
 * Post-compaction context accounting observed by the native compaction producer.
 *
 * `available` records a reliable app-server snapshot (contextUsage is the
 * transcript boundary readers already understand); `unavailable` explicitly
 * marks usage as unknown so transcript fallback cannot resurrect the stale
 * pre-compaction count. Billing history is unaffected: this representation
 * carries no input/output/cache/cost buckets.
 */
export type CodexCompactionUsageAfter =
  | { state: "available"; promptTokens: number; totalTokens: number }
  | { state: "unavailable" };

export async function persistCodexContextCompactionActivity(params: {
  sessionTarget?: EmbeddedRunAttemptParams["sessionTarget"];
  config?: EmbeddedRunAttemptParams["config"];
  cwd?: string;
  runId?: string;
  threadId: string;
  turnId: string;
  itemId: string;
  timestamp: number;
  /** Post-compaction context usage; omitted only when no accounting boundary is needed. */
  usageAfter?: CodexCompactionUsageAfter;
}): Promise<void> {
  const target = params.sessionTarget;
  if (!target?.sessionId || !target.sessionKey || !target.storePath) {
    return;
  }
  const activityId = `codex-context-compaction:${params.threadId}:${params.turnId}:${params.itemId}`;
  const message = {
    role: "custom" as const,
    customType: CONTEXT_COMPACTION_CUSTOM_TYPE,
    content: "Context compacted",
    display: true,
    excludeFromContext: true,
    details: {
      kind: "context_compaction",
      backend: "codex-app-server",
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      ...(params.runId ? { runId: params.runId } : {}),
    },
    // Carried in the normalized usage shape so transcript-derived readers treat
    // this marker as an accounting boundary (available replaces the context
    // count, unavailable clears it until a later valid snapshot).
    ...(params.usageAfter ? { usage: { contextUsage: params.usageAfter } } : {}),
    __openclaw: { itemId: params.itemId, ...(params.runId ? { runId: params.runId } : {}) },
    timestamp: params.timestamp,
    idempotencyKey: activityId,
  };
  try {
    const appended = await appendSessionTranscriptMessageByIdentity({
      agentId: target.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
      config: params.config,
      cwd: params.cwd,
      eventId: activityId,
      message,
    });
    if (!appended?.appended) {
      return;
    }
    await publishSessionTranscriptUpdateByIdentity({
      agentId: target.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
      update: {
        message: appended.message,
        messageId: appended.messageId,
        ...(params.runId ? { runId: params.runId } : {}),
      },
    });
  } catch (error) {
    embeddedAgentLog.warn("failed to persist codex context compaction activity", {
      error: formatErrorMessage(error),
      itemId: params.itemId,
    });
  }
}
