/**
 * Runs compaction hooks and post-compaction side effects for embedded sessions.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { getActiveMemorySearchManagerCore } from "../../plugins/memory-runtime.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchIndexConfig } from "../memory-search.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  estimateCompactedRequestTokens,
  type CompactionRequestBudget,
} from "../sessions/compaction/request-budget.js";
import { log } from "./logger.js";

function resolvePostCompactionIndexSyncMode(config?: OpenClawConfig): "off" | "async" | "await" {
  const mode = config?.agents?.defaults?.compaction?.postIndexSync;
  if (mode === "off" || mode === "async" || mode === "await") {
    return mode;
  }
  return "async";
}

type PostCompactionSession = {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  sessionFile: string;
  assertActive?: () => void;
};

async function runPostCompactionSessionMemorySync(params: PostCompactionSession): Promise<void> {
  if (!params.config) {
    return;
  }
  try {
    const sessionFile = params.sessionFile.trim();
    if (!sessionFile) {
      return;
    }
    const agentId = resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.config,
      agentId: params.agentId,
    });
    // The memory backend owns provider resolution; an unavailable backend must
    // not cold-load embedding plugins just to decide whether to sync.
    const resolvedMemory = resolveMemorySearchIndexConfig(params.config, agentId);
    if (!resolvedMemory || !resolvedMemory.sources.includes("sessions")) {
      return;
    }
    if (!resolvedMemory.sync.sessions.postCompactionForce) {
      return;
    }
    params.assertActive?.();
    const { manager } = await getActiveMemorySearchManagerCore({
      cfg: params.config,
      agentId,
    });
    params.assertActive?.();
    if (!manager?.sync) {
      return;
    }
    const sessionId = params.sessionId?.trim();
    await manager.sync({
      reason: "post-compaction",
      ...(sessionId
        ? {
            sessions: [
              {
                agentId,
                sessionId,
                ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
              },
            ],
          }
        : { archiveFiles: [sessionFile] }),
    });
  } catch (err) {
    params.assertActive?.();
    log.warn(`memory sync skipped (post-compaction): ${formatErrorMessage(err)}`);
  }
}

function syncPostCompactionSessionMemory(
  params: PostCompactionSession & {
    mode: "off" | "async" | "await";
  },
): Promise<void> {
  if (params.mode === "off" || !params.config) {
    return Promise.resolve();
  }

  const syncTask = runPostCompactionSessionMemorySync(params);
  if (params.mode === "await") {
    return syncTask;
  }
  // Async indexing must not retain a closed foreground owner or leak an abort
  // rejection after the caller has already settled its turn.
  void syncTask.catch((error: unknown) => {
    log.debug(`memory sync cancelled (post-compaction): ${formatErrorMessage(error)}`);
  });
  return Promise.resolve();
}

/** Emits post-compaction transcript and memory-index side effects for a compacted session file. */
export async function runPostCompactionSideEffects(params: PostCompactionSession): Promise<void> {
  params.assertActive?.();
  const sessionFile = params.sessionFile.trim();
  if (!sessionFile) {
    return;
  }
  emitSessionTranscriptUpdate({
    sessionFile,
    sessionKey: params.sessionKey,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  params.assertActive?.();
  await syncPostCompactionSessionMemory({
    ...params,
    sessionFile,
    mode: resolvePostCompactionIndexSyncMode(params.config),
  });
  params.assertActive?.();
}

/** Narrow adapter over the global hook runner methods used by compaction. */
type CompactionHookRunner = {
  hasHooks?: (hookName?: string) => boolean;
  runBeforeCompaction?: (
    metrics: { messageCount: number; tokenCount?: number; sessionFile?: string },
    context: {
      sessionId: string;
      agentId: string;
      sessionKey: string;
      workspaceDir: string;
      messageProvider?: string;
    },
  ) => Promise<void> | void;
  runAfterCompaction?: (
    metrics: {
      messageCount: number;
      tokenCount?: number;
      compactedCount: number;
      sessionFile: string;
    },
    context: {
      sessionId: string;
      agentId: string;
      sessionKey: string;
      workspaceDir: string;
      messageProvider?: string;
    },
  ) => Promise<void> | void;
};

/** Converts the global hook runner into the compaction-specific hook shape. */
export function asCompactionHookRunner(
  hookRunner: ReturnType<typeof getGlobalHookRunner> | null | undefined,
): CompactionHookRunner | null {
  if (!hookRunner) {
    return null;
  }
  return {
    hasHooks: (hookName?: string) => hookRunner.hasHooks?.(hookName as never) ?? false,
    runBeforeCompaction: hookRunner.runBeforeCompaction?.bind(hookRunner),
    runAfterCompaction: hookRunner.runAfterCompaction?.bind(hookRunner),
  };
}

function estimateTokenCountSafe(
  messages: AgentMessage[],
  estimateTokensFn: (message: AgentMessage) => number,
): number | undefined {
  try {
    let total = 0;
    for (const message of messages) {
      total += estimateTokensFn(message);
    }
    return total;
  } catch {
    return undefined;
  }
}

/** Builds before-hook metrics while tolerating providers that cannot estimate all messages. */
export function buildBeforeCompactionHookMetrics(params: {
  originalMessages: AgentMessage[];
  currentMessages: AgentMessage[];
  observedTokenCount?: number;
  estimateTokensFn: (message: AgentMessage) => number;
}) {
  return {
    messageCountOriginal: params.originalMessages.length,
    tokenCountOriginal: estimateTokenCountSafe(params.originalMessages, params.estimateTokensFn),
    messageCountBefore: params.currentMessages.length,
    tokenCountBefore:
      params.observedTokenCount ??
      estimateTokenCountSafe(params.currentMessages, params.estimateTokensFn),
  };
}

/** Runs internal and plugin before-compaction hooks, forwarding hook-produced messages. */
export async function runBeforeCompactionHooks(params: {
  hookRunner?: CompactionHookRunner | null;
  sessionId: string;
  sessionKey: string;
  sessionAgentId: string;
  workspaceDir: string;
  messageProvider?: string;
  metrics: ReturnType<typeof buildBeforeCompactionHookMetrics>;
  assertActive?: () => void;
  onHookMessages?: (payload: {
    phase: "before";
    messages: string[];
    sessionId: string;
    sessionKey: string;
  }) => void | Promise<void>;
}) {
  const missingSessionKey = false;
  const hookSessionKey = params.sessionKey;
  params.assertActive?.();
  try {
    const hookEvent = createInternalHookEvent("session", "compact:before", hookSessionKey, {
      sessionId: params.sessionId,
      missingSessionKey,
      messageCount: params.metrics.messageCountBefore,
      tokenCount: params.metrics.tokenCountBefore,
      messageCountOriginal: params.metrics.messageCountOriginal,
      tokenCountOriginal: params.metrics.tokenCountOriginal,
    });
    await triggerInternalHook(hookEvent);
    params.assertActive?.();
    if (hookEvent.messages.length > 0) {
      await params.onHookMessages?.({
        phase: "before",
        messages: hookEvent.messages.slice(),
        sessionId: params.sessionId,
        sessionKey: hookSessionKey,
      });
    }
  } catch (err) {
    params.assertActive?.();
    log.warn("session:compact:before hook failed", {
      errorMessage: formatErrorMessage(err),
      errorStack: err instanceof Error ? err.stack : undefined,
    });
  }
  params.assertActive?.();
  if (params.hookRunner?.hasHooks?.("before_compaction")) {
    try {
      await params.hookRunner.runBeforeCompaction?.(
        {
          messageCount: params.metrics.messageCountBefore,
          tokenCount: params.metrics.tokenCountBefore,
        },
        {
          sessionId: params.sessionId,
          agentId: params.sessionAgentId,
          sessionKey: hookSessionKey,
          workspaceDir: params.workspaceDir,
          messageProvider: params.messageProvider,
        },
      );
    } catch (err) {
      params.assertActive?.();
      log.warn("before_compaction hook failed", {
        errorMessage: formatErrorMessage(err),
        errorStack: err instanceof Error ? err.stack : undefined,
      });
    }
  }
  params.assertActive?.();
  return {
    hookSessionKey,
    missingSessionKey,
  };
}

/** Estimates compacted-session token count and rejects impossible growth from stale estimates. */
export function estimateTokensAfterCompaction(params: {
  messagesAfter: AgentMessage[];
  observedTokenCount?: number;
  fullSessionTokensBefore: number;
  estimateTokensFn: (message: AgentMessage) => number;
  requestBudget?: CompactionRequestBudget;
}) {
  if (params.requestBudget) {
    return estimateCompactedRequestTokens(params.messagesAfter, {
      ...params.requestBudget,
      pendingTokens: 0,
    });
  }
  const tokensAfter = estimateTokenCountSafe(params.messagesAfter, params.estimateTokensFn);
  if (tokensAfter === undefined) {
    return undefined;
  }
  const sanityCheckBaseline = params.observedTokenCount ?? params.fullSessionTokensBefore;
  if (
    sanityCheckBaseline > 0 &&
    tokensAfter >
      (params.observedTokenCount !== undefined ? sanityCheckBaseline : sanityCheckBaseline * 1.1)
  ) {
    return undefined;
  }
  return tokensAfter;
}

/** Runs internal and plugin after-compaction hooks with the final compacted metrics. */
export async function runAfterCompactionHooks(params: {
  hookRunner?: CompactionHookRunner | null;
  sessionId: string;
  sessionAgentId: string;
  hookSessionKey: string;
  missingSessionKey: boolean;
  workspaceDir: string;
  messageProvider?: string;
  messageCountAfter: number;
  tokensAfter?: number;
  compactedCount: number;
  sessionFile: string;
  previousSessionId?: string;
  summaryLength?: number;
  tokensBefore?: number;
  firstKeptEntryId?: string;
  assertActive?: () => void;
  onHookMessages?: (payload: {
    phase: "after";
    messages: string[];
    sessionId: string;
    sessionKey: string;
  }) => void | Promise<void>;
}) {
  params.assertActive?.();
  try {
    const hookEvent = createInternalHookEvent("session", "compact:after", params.hookSessionKey, {
      sessionId: params.sessionId,
      missingSessionKey: params.missingSessionKey,
      messageCount: params.messageCountAfter,
      tokenCount: params.tokensAfter,
      compactedCount: params.compactedCount,
      summaryLength: params.summaryLength,
      tokensBefore: params.tokensBefore,
      tokensAfter: params.tokensAfter,
      firstKeptEntryId: params.firstKeptEntryId,
    });
    await triggerInternalHook(hookEvent);
    params.assertActive?.();
    if (hookEvent.messages.length > 0) {
      await params.onHookMessages?.({
        phase: "after",
        messages: hookEvent.messages.slice(),
        sessionId: params.sessionId,
        sessionKey: params.hookSessionKey,
      });
    }
  } catch (err) {
    params.assertActive?.();
    log.warn("session:compact:after hook failed", {
      errorMessage: formatErrorMessage(err),
      errorStack: err instanceof Error ? err.stack : undefined,
    });
  }
  params.assertActive?.();
  if (params.hookRunner?.hasHooks?.("after_compaction")) {
    try {
      await params.hookRunner.runAfterCompaction?.(
        {
          messageCount: params.messageCountAfter,
          tokenCount: params.tokensAfter,
          compactedCount: params.compactedCount,
          sessionFile: params.sessionFile,
          ...(params.previousSessionId ? { previousSessionId: params.previousSessionId } : {}),
        },
        {
          sessionId: params.sessionId,
          agentId: params.sessionAgentId,
          sessionKey: params.hookSessionKey,
          workspaceDir: params.workspaceDir,
          messageProvider: params.messageProvider,
        },
      );
    } catch (err) {
      params.assertActive?.();
      log.warn("after_compaction hook failed", {
        errorMessage: formatErrorMessage(err),
        errorStack: err instanceof Error ? err.stack : undefined,
      });
    }
  }
  params.assertActive?.();
}
