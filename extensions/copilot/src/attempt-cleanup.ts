import {
  awaitAgentEndSideEffects,
  runAgentEndSideEffects,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { toCopilotError } from "./attempt-config.js";
import {
  BACKGROUND_COMPACTION_CANCEL_TIMEOUT_MS,
  type AgentHarnessAttemptResult,
  type AttemptParamsLike,
  type CopilotAgentEndHookParams,
} from "./attempt-types.js";
import { attachEventBridge, type SessionLike } from "./event-bridge.js";
import type { CopilotClientPool, PooledClient } from "./runtime.js";
export async function finalizeCopilotAttempt(
  params: AttemptParamsLike,
  result: AgentHarnessAttemptResult,
  ctx: CopilotAgentEndHookParams["ctx"],
  attemptStartedAt: number,
  now: () => number,
): Promise<AgentHarnessAttemptResult> {
  const failure =
    result.terminal.kind === "failed"
      ? { error: result.terminal.error }
      : result.terminal.kind === "ok"
        ? undefined
        : result.terminal.failure;
  const aborted = result.terminal.kind === "aborted" && result.terminal.source !== "yield_cleanup";
  const timedOut = result.terminal.kind === "timeout" && result.terminal.source !== "observation";
  const hookParams = {
    event: {
      messages: result.messagesSnapshot,
      success: !aborted && !failure && !timedOut,
      ...(failure
        ? { error: toCopilotError(failure.error).message }
        : timedOut
          ? { error: "Copilot SDK turn timed out." }
          : {}),
      durationMs: now() - attemptStartedAt,
    },
    ctx,
  };
  if (!params.messageChannel && !params.messageProvider) {
    await awaitAgentEndSideEffects(hookParams);
  } else {
    runAgentEndSideEffects(hookParams);
  }
  return result;
}
export function deferBackgroundCompactionCleanup(params: {
  abortSignal: AbortSignal | undefined;
  awaitSessionIdle: boolean;
  bridge: ReturnType<typeof attachEventBridge>;
  handle: PooledClient;
  pool: CopilotClientPool;
  cleanupByokProxy?: () => Promise<void>;
  cleanupToolBridge?: () => void;
  deleteSessionOnIncompleteCleanup: boolean;
  finalizeNativeSubagents?: () => void;
  sdkSessionId?: string;
  session: SessionLike;
  timeoutMs: number;
}): Promise<"aborted" | "completed" | "deadline"> {
  return (async () => {
    let outcome: "aborted" | "completed" | "deadline" = "deadline";
    try {
      outcome = await awaitDeferredCleanupBeforeDeadline({
        abortSignal: params.abortSignal,
        awaitSessionIdle: params.awaitSessionIdle,
        bridge: params.bridge,
        timeoutMs: params.timeoutMs,
      });
    } catch {
    } finally {
      if (outcome !== "completed") {
        await cancelBackgroundCompactionBeforeTeardown(params.session);
        params.bridge.settleCompactionWait();
      }
      params.finalizeNativeSubagents?.();
      params.bridge.detach();
      try {
        await params.session.disconnect();
      } catch {}
      params.cleanupToolBridge?.();
      await params.cleanupByokProxy?.();
      if (
        outcome !== "completed" &&
        params.deleteSessionOnIncompleteCleanup &&
        params.sdkSessionId
      ) {
        try {
          await params.handle.client.deleteSession(params.sdkSessionId);
        } catch {}
      }
      try {
        await params.pool.release(params.handle);
      } catch {}
    }
    return outcome;
  })();
}
async function cancelBackgroundCompactionBeforeTeardown(session: SessionLike): Promise<void> {
  const cancelBackgroundCompaction = session.rpc?.history?.cancelBackgroundCompaction;
  if (!cancelBackgroundCompaction) {
    return;
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timeoutId = setTimeout(resolve, BACKGROUND_COMPACTION_CANCEL_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => cancelBackgroundCompaction())
        .catch(() => undefined),
      deadline,
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
async function awaitDeferredCleanupBeforeDeadline(params: {
  abortSignal: AbortSignal | undefined;
  awaitSessionIdle: boolean;
  bridge: ReturnType<typeof attachEventBridge>;
  timeoutMs: number;
}): Promise<"aborted" | "completed" | "deadline"> {
  if (params.abortSignal?.aborted) {
    return "aborted";
  }
  const completion = (async () => {
    if (params.awaitSessionIdle) {
      await params.bridge.awaitSessionIdle();
    }
    await params.bridge.awaitCompactionCompletion();
    return "completed" as const;
  })();
  let resolveAbort: () => void = () => undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    resolveAbort = () => resolve("aborted");
    params.abortSignal?.addEventListener("abort", resolveAbort, { once: true });
  });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timeoutId = setTimeout(() => resolve("deadline"), params.timeoutMs);
  });
  try {
    return await Promise.race([completion, aborted, deadline]);
  } finally {
    params.abortSignal?.removeEventListener("abort", resolveAbort);
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
