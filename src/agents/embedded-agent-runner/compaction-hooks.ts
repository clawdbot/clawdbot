/**
 * Runs compaction hooks and post-compaction side effects for embedded sessions.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { getActiveMemorySearchManager } from "../../plugins/memory-runtime.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import type { AgentMessage } from "../runtime/index.js";
import { log } from "./logger.js";

function resolvePostCompactionIndexSyncMode(config?: OpenClawConfig): "off" | "async" | "await" {
  const mode = config?.agents?.defaults?.compaction?.postIndexSync;
  if (mode === "off" || mode === "async" || mode === "await") {
    return mode;
  }
  return "async";
}

async function runPostCompactionSessionMemorySync(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  sessionFile: string;
}): Promise<void> {
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
    const resolvedMemory = resolveMemorySearchConfig(params.config, agentId);
    if (!resolvedMemory || !resolvedMemory.sources.includes("sessions")) {
      return;
    }
    if (!resolvedMemory.sync.sessions.postCompactionForce) {
      return;
    }
    const { manager } = await getActiveMemorySearchManager({
      cfg: params.config,
      agentId,
    });
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
    log.warn(`memory sync skipped (post-compaction): ${formatErrorMessage(err)}`);
  }
}

function syncPostCompactionSessionMemory(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  sessionFile: string;
  mode: "off" | "async" | "await";
}): Promise<void> {
  if (params.mode === "off" || !params.config) {
    return Promise.resolve();
  }

  const syncTask = runPostCompactionSessionMemorySync({
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    sessionFile: params.sessionFile,
  });
  if (params.mode === "await") {
    return syncTask;
  }
  // Async mode should never hold the user turn open; failures are logged inside the task.
  void syncTask;
  return Promise.resolve();
}

/** Emits post-compaction transcript and memory-index side effects for a compacted session file. */
export async function runPostCompactionSideEffects(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  sessionFile: string;
}): Promise<void> {
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
  await syncPostCompactionSessionMemory({
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    sessionFile,
    mode: resolvePostCompactionIndexSyncMode(params.config),
  });
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
      reason?: string;
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
  sessionKey?: string;
  sessionAgentId: string;
  workspaceDir: string;
  messageProvider?: string;
  metrics: ReturnType<typeof buildBeforeCompactionHookMetrics>;
  onHookMessages?: (payload: {
    phase: "before";
    messages: string[];
    sessionId: string;
    sessionKey: string;
  }) => void | Promise<void>;
}) {
  const missingSessionKey = !params.sessionKey || !params.sessionKey.trim();
  const hookSessionKey = params.sessionKey?.trim() || params.sessionId;
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
    if (hookEvent.messages.length > 0) {
      await params.onHookMessages?.({
        phase: "before",
        messages: hookEvent.messages.slice(),
        sessionId: params.sessionId,
        sessionKey: hookSessionKey,
      });
    }
  } catch (err) {
    log.warn("session:compact:before hook failed", {
      errorMessage: formatErrorMessage(err),
      errorStack: err instanceof Error ? err.stack : undefined,
    });
  }
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
      log.warn("before_compaction hook failed", {
        errorMessage: formatErrorMessage(err),
        errorStack: err instanceof Error ? err.stack : undefined,
      });
    }
  }
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
}) {
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

type AfterCompactionHookParams = {
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
  reason?: string;
  onHookMessages?: (payload: {
    phase: "after";
    messages: string[];
    sessionId: string;
    sessionKey: string;
  }) => void | Promise<void>;
};

type SkippedCompactionHookBase = Omit<
  AfterCompactionHookParams,
  | "messageCountAfter"
  | "tokensAfter"
  | "compactedCount"
  | "sessionFile"
  | "reason"
  | "previousSessionId"
  | "summaryLength"
  | "tokensBefore"
  | "firstKeptEntryId"
>;

/** Runs after-compaction hooks for a compaction that completed without compacting anything. */
export async function runSkippedCompactionHooks(
  base: SkippedCompactionHookBase,
  skip: {
    messageCountAfter: number;
    tokensAfter?: number;
    sessionFile: string;
    reason: string;
  },
) {
  await runAfterCompactionHooks({ ...base, ...skip, compactedCount: 0 });
}

/** Runs internal and plugin after-compaction hooks with the final compacted metrics. */
export async function runAfterCompactionHooks(params: AfterCompactionHookParams) {
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
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
    });
    await triggerInternalHook(hookEvent);
    if (hookEvent.messages.length > 0) {
      await params.onHookMessages?.({
        phase: "after",
        messages: hookEvent.messages.slice(),
        sessionId: params.sessionId,
        sessionKey: params.hookSessionKey,
      });
    }
  } catch (err) {
    log.warn("session:compact:after hook failed", {
      errorMessage: formatErrorMessage(err),
      errorStack: err instanceof Error ? err.stack : undefined,
    });
  }
  if (params.hookRunner?.hasHooks?.("after_compaction")) {
    try {
      await params.hookRunner.runAfterCompaction?.(
        {
          messageCount: params.messageCountAfter,
          tokenCount: params.tokensAfter,
          compactedCount: params.compactedCount,
          sessionFile: params.sessionFile,
          ...(params.previousSessionId ? { previousSessionId: params.previousSessionId } : {}),
          ...(params.reason !== undefined ? { reason: params.reason } : {}),
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
      log.warn("after_compaction hook failed", {
        errorMessage: formatErrorMessage(err),
        errorStack: err instanceof Error ? err.stack : undefined,
      });
    }
  }
}
