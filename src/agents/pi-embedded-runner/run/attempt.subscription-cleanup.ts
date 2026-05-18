import type { SubscribeEmbeddedPiSessionParams } from "../../pi-embedded-subscribe.types.js";
import { log } from "../logger.js";

export const EMBEDDED_ABORT_SETTLE_TIMEOUT_MS =
  process.env.OPENCLAW_TEST_FAST === "1" ? 250 : 2_000;

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
  const outcome = await Promise.race([
    params.promise
      .then(() => "settled" as const)
      .catch((err) => {
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

export function buildEmbeddedSubscriptionParams(
  params: SubscribeEmbeddedPiSessionParams,
): SubscribeEmbeddedPiSessionParams {
  return params;
}

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
  } finally {
    await params.sessionLock.release();
  }
}
