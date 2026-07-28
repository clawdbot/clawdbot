/**
 * Builds subscription params and cleans up embedded attempt resources.
 */
import { toErrorObject } from "../../../infra/errors.js";
import type { SubscribeEmbeddedAgentSessionParams } from "../../embedded-agent-subscribe.types.js";
import { log } from "../logger.js";
import { resolveEmbeddedAbortSettleTimeoutMs } from "./attempt.abort-settle-timeout.js";

/** Shared timeout for waiting on aborted model/prompt cleanup before releasing resources. */
const EMBEDDED_ABORT_SETTLE_TIMEOUT_MS = resolveEmbeddedAbortSettleTimeoutMs();

type IdleAwareAgent = {
  waitForIdle?: (() => Promise<void>) | undefined;
};

type ToolResultFlushManager = {
  flushPendingToolResults?: (() => void) | undefined;
  clearPendingToolResults?: (() => void) | undefined;
};

async function waitForEmbeddedAbortSettle(params: {
  promise: Promise<unknown> | null | undefined;
  runId: string;
  sessionId: string;
}): Promise<void> {
  if (!params.promise) {
    return;
  }

  let timeout: NodeJS.Timeout | undefined;
  // Abort settlement is advisory cleanup; timeout or errors are logged but do
  // not block releasing the session write-lock.
  const outcome = await Promise.race([
    params.promise
      .then(() => "settled" as const)
      .catch((err: unknown) => {
        log.warn(
          `embedded abort settle failed: runId=${params.runId} sessionId=${params.sessionId} err=${String(err)}`,
        );
        return "errored" as const;
      }),
    new Promise<"timed_out">((resolve) => {
      timeout = setTimeout(() => resolve("timed_out"), EMBEDDED_ABORT_SETTLE_TIMEOUT_MS);
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  if (outcome === "timed_out") {
    log.warn(
      `embedded abort settle timed out: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${EMBEDDED_ABORT_SETTLE_TIMEOUT_MS}`,
    );
  }
}

/**
 * Identity helper that preserves the concrete subscription params type at call
 * sites. Keeping this as a named helper lets tests assert the exact shape passed
 * into the subscription layer without widening the object inline.
 */
export function buildEmbeddedSubscriptionParams(
  params: SubscribeEmbeddedAgentSessionParams,
): SubscribeEmbeddedAgentSessionParams {
  return params;
}

/**
 * Tears down per-attempt resources in lock-safe order: remove guards, settle
 * aborted prompts, flush tool results, release the session lock, then dispose
 * runtimes. Lock release errors are reported after best-effort disposal so a
 * failed lock does not leak spawned runtimes.
 */
export async function cleanupEmbeddedAttemptResources(params: {
  removeToolResultContextGuard?: () => void;
  flushPendingToolResultsAfterIdle: (params: {
    agent: IdleAwareAgent | null | undefined;
    sessionManager: ToolResultFlushManager | null | undefined;
    timeoutMs?: number;
  }) => Promise<void>;
  session?: { agent?: unknown; dispose(): void };
  sessionManager: unknown;
  bundleMcpRuntime?: { dispose(): Promise<void> | void };
  bundleLspRuntime?: { dispose(): Promise<void> | void };
  sessionLock: { release(): Promise<void> | void };
  aborted?: boolean;
  abortSettlePromise?: Promise<unknown> | null;
  skipSessionFlush?: boolean;
  runId?: string;
  sessionId?: string;
}): Promise<void> {
  let sessionLockReleaseError: unknown;
  try {
    try {
      params.removeToolResultContextGuard?.();
    } catch {
      /* best-effort */
    }
    if (params.aborted && params.abortSettlePromise) {
      await waitForEmbeddedAbortSettle({
        promise: params.abortSettlePromise,
        runId: params.runId ?? "unknown",
        sessionId: params.sessionId ?? "unknown",
      });
    }
    // PERF: When the run was aborted (user stop / timeout), skip the expensive
    // waitForIdle (up to 30 s) and flush pending tool results synchronously so
    // the session write-lock is released without leaving orphaned tool calls.
    if (!params.skipSessionFlush) {
      try {
        await params.flushPendingToolResultsAfterIdle({
          agent: params.session?.agent as IdleAwareAgent | null | undefined,
          sessionManager: params.sessionManager as ToolResultFlushManager | null | undefined,
          ...(params.aborted ? { timeoutMs: 0 } : {}),
        });
      } catch {
        /* best-effort */
      }
    }
  } finally {
    try {
      // Release the write-lock before disposing runtimes so another attempt can
      // recover even if runtime disposal stalls or throws.
      await params.sessionLock.release();
    } catch (err) {
      sessionLockReleaseError = err;
    }
  }

  try {
    params.session?.dispose();
  } catch {
    /* best-effort */
  }
  try {
    await params.bundleMcpRuntime?.dispose();
  } catch {
    /* best-effort */
  }
  try {
    await params.bundleLspRuntime?.dispose();
  } catch {
    /* best-effort */
  }

  if (sessionLockReleaseError) {
    throw toErrorObject(sessionLockReleaseError, "Non-Error thrown");
  }
}
