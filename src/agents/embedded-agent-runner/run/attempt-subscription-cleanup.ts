/** Cleans up embedded attempt subscription resources. */
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { isFastTestRuntimeEnv } from "../../../infra/test-runtime-env.js";
import { recordAgentCleanupFailure, runAgentCleanupStep } from "../../run-cleanup-timeout.js";
import { log } from "../logger.js";

// Invalid overrides retain the normal/test defaults; partial numeric parsing
// must not silently widen cleanup waits.
const EMBEDDED_ABORT_SETTLE_TIMEOUT_MS =
  parseStrictPositiveInteger(process.env.OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS) ??
  (isFastTestRuntimeEnv() ? 250 : 2_000);

type IdleAwareAgent = {
  waitForIdle?: (() => Promise<void>) | undefined;
};

type ToolResultFlushManager = {
  flushPendingToolResults?: (() => void) | undefined;
  clearPendingToolResults?: (() => void) | undefined;
};

export async function waitForEmbeddedAbortSettle(params: {
  promise: Promise<unknown> | null | undefined;
  runId: string;
  sessionId: string;
  reason?: "embedded" | "sessions_yield";
}): Promise<void> {
  if (!params.promise) {
    return;
  }

  await runAgentCleanupStep({
    runId: params.runId,
    sessionId: params.sessionId,
    step: `${params.reason ?? "embedded"}-abort-settle`,
    log,
    timeoutMs: EMBEDDED_ABORT_SETTLE_TIMEOUT_MS,
    cleanup: async () => {
      await params.promise;
    },
  });
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
    recordAgentCleanupFailure();
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
    recordAgentCleanupFailure();
  }

  try {
    params.session?.dispose();
  } catch {
    recordAgentCleanupFailure();
  }
  try {
    await params.bundleMcpRuntime?.dispose();
  } catch {
    recordAgentCleanupFailure();
  }
  try {
    await params.bundleLspRuntime?.dispose();
  } catch {
    recordAgentCleanupFailure();
  }
}
