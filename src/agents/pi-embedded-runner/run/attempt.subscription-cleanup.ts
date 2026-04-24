import type { SubscribeEmbeddedPiSessionParams } from "../../pi-embedded-subscribe.types.js";

type IdleAwareAgent = {
  waitForIdle?: (() => Promise<void>) | undefined;
};

type ToolResultFlushManager = {
  flushPendingToolResults?: (() => void) | undefined;
  clearPendingToolResults?: (() => void) | undefined;
};
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
    clearPendingOnTimeout?: boolean;
  }) => Promise<void>;
  session?: { agent?: unknown; dispose(): void };
  sessionManager: unknown;
  releaseWsSession: (sessionId: string, options?: { allowPool?: boolean }) => void;
  allowWsSessionPool?: boolean;
  sessionId: string;
  bundleLspRuntime?: { dispose(): Promise<void> | void };
  sessionLock: { release(): Promise<void> | void };
}): Promise<void> {
  try {
    try {
      params.removeToolResultContextGuard?.();
    } catch {
      /* best-effort */
    }
    try {
      await params.flushPendingToolResultsAfterIdle({
        agent: params.session?.agent as IdleAwareAgent | null | undefined,
        sessionManager: params.sessionManager as ToolResultFlushManager | null | undefined,
        clearPendingOnTimeout: true,
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
      params.releaseWsSession(params.sessionId, { allowPool: params.allowWsSessionPool === true });
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
