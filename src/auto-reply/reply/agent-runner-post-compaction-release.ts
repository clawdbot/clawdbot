import { resolveContextTokensForModel } from "../../agents/context.js";
import type { EmbeddedAgentCompactResult } from "../../agents/embedded-agent-runner/types.js";
import {
  resolveFreshSessionTotalTokens,
  type SessionEntry,
  type SessionPostCompactionDelegate,
} from "../../config/sessions.js";
import { resolveSessionEntryFromStore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { stagePostCompactionDelegate } from "../continuation/delegate-store-post-compaction.js";
import type { FollowupRun } from "./queue.js";

export async function releaseQueuedCompactionCompletion(params: {
  activeSessionStore?: Record<string, SessionEntry>;
  compactionResult: EmbeddedAgentCompactResult;
  followupRun: FollowupRun;
  getActiveSessionEntry: () => SessionEntry | undefined;
  sessionKey?: string;
  storePath?: string;
  traceparent?: string;
}): Promise<void> {
  if (!params.compactionResult.ok || !params.compactionResult.compacted) {
    return;
  }
  if (!params.sessionKey || !params.activeSessionStore) {
    logVerbose(
      `[request_compaction:post-compaction-release-skipped] session=${params.sessionKey ?? "none"} reason=session-store-unavailable`,
    );
    return;
  }
  const sessionEntry =
    params.getActiveSessionEntry() ?? params.activeSessionStore[params.sessionKey];
  if (!sessionEntry) {
    logVerbose(
      `[request_compaction:post-compaction-release-skipped] session=${params.sessionKey} reason=session-entry-unavailable`,
    );
    return;
  }

  const { incrementRunCompactionCount } = await import("./session-run-accounting.js");
  const compactionId = await incrementRunCompactionCount({
    agentId: params.followupRun.run.agentId,
    cfg: params.followupRun.run.config,
    sessionEntry,
    sessionStore: params.activeSessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    amount: 1,
    compactionTokensAfter: params.compactionResult.result?.tokensAfter,
    newSessionId: params.compactionResult.result?.sessionId,
  });
  const resolved = resolveSessionEntryFromStore({
    store: params.activeSessionStore,
    sessionKey: params.sessionKey,
  });
  await releasePostCompactionDelegatesAfterCompaction({
    activeSessionStore: params.activeSessionStore,
    compactionCount: compactionId,
    followupRun: params.followupRun,
    sessionEntry: resolved.existing ?? sessionEntry,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    traceparent: params.traceparent,
  });
}

export async function releasePostCompactionDelegatesAfterCompaction(params: {
  activeSessionStore: Record<string, SessionEntry>;
  compactionCount: number | undefined;
  followupRun: FollowupRun;
  sessionEntry: SessionEntry;
  sessionKey: string;
  storePath?: string;
  traceparent?: string;
}): Promise<void> {
  const { dispatchPostCompactionDelegates } =
    await import("./post-compaction-delegate-dispatch.js");
  const delegatesToPreserve: SessionPostCompactionDelegate[] = [];
  const dispatchResult = await dispatchPostCompactionDelegates({
    cfg: params.followupRun.run.config,
    compactionCount: params.compactionCount,
    followupRun: params.followupRun,
    postCompactionDelegatesToPreserve: delegatesToPreserve,
    releaseTraceparent: params.traceparent,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    sessionStore: params.activeSessionStore,
    storePath: params.storePath,
  });
  for (const delegate of delegatesToPreserve) {
    stagePostCompactionDelegate(params.sessionKey, delegate);
  }

  const { emitContinuationCompactionReleasedSpan } =
    await import("../../infra/continuation-tracer.js");
  emitContinuationCompactionReleasedSpan({
    releasedCount: dispatchResult.queuedDelegates,
    compactionId: params.compactionCount,
    traceparent: params.traceparent,
    log: (message) => logVerbose(message),
  });
}

export async function releaseQueuedCompactionTolerant(
  params: Parameters<typeof releaseQueuedCompactionCompletion>[0],
): Promise<void> {
  try {
    await releaseQueuedCompactionCompletion(params);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logVerbose(
      `[request_compaction:post-compaction-release-failed] session=${params.sessionKey ?? "none"} reason=${reason}`,
    );
  }
}

export function computeRequestCompactionContextUsage(params: {
  entry: SessionEntry | undefined;
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
}): number | null {
  const freshTotalTokens = resolveFreshSessionTotalTokens(params.entry);
  if (freshTotalTokens === undefined) {
    return null;
  }
  const contextWindow =
    params.entry?.contextTokens ??
    resolveContextTokensForModel({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      allowAsyncLoad: false,
    });
  return typeof contextWindow === "number" && contextWindow > 0
    ? freshTotalTokens / contextWindow
    : null;
}
