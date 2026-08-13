/** Cleans up embedded attempt subscription resources. */
import { log } from "../logger.js";
import { resolveEmbeddedAbortSettleTimeoutMs } from "./attempt-finalize.js";

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
  // not block disposing attempt-owned resources.
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
 * Tears down per-attempt resources after the transcript lifecycle has drained:
 * remove guards, settle aborted prompts, flush tool results, then dispose runtimes.
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
  aborted?: boolean;
  abortSettlePromise?: Promise<unknown> | null;
  runId?: string;
  sessionId?: string;
}): Promise<void> {
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
  try {
    await params.flushPendingToolResultsAfterIdle({
      agent: params.session?.agent as IdleAwareAgent | null | undefined,
      sessionManager: params.sessionManager as ToolResultFlushManager | null | undefined,
      ...(params.aborted ? { timeoutMs: 0 } : {}),
    });
  } catch {
    /* best-effort */
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
}
