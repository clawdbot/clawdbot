/**
 * Best-effort cleanup helpers for Codex app-server startup attempts and turns.
 */
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { unsubscribeCodexAppServerLiveThread } from "./client-runtime.js";
import { CodexAppServerRpcError, type CodexAppServerClient } from "./client.js";
import { retireSharedCodexAppServerClientIfCurrent } from "./shared-client.js";
import { getCodexAppServerTurnRouter } from "./turn-router.js";

/** Timeout for best-effort app-server turn interruption during cleanup. */
export const CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS = 5_000;
/** Timeout for best-effort thread unsubscribe during cleanup. */
export const CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS = 5_000;
const CODEX_NO_ACTIVE_TURN_ERROR_CODE = -32_600;
const CODEX_NO_ACTIVE_TURN_ERROR_MESSAGE = "no active turn to interrupt";

/** Identifies Codex's exact proof that an interrupt target already finished. */
export function isCodexAlreadyTerminalInterruptError(
  error: unknown,
): error is CodexAppServerRpcError {
  return (
    error instanceof CodexAppServerRpcError &&
    error.code === CODEX_NO_ACTIVE_TURN_ERROR_CODE &&
    error.message === CODEX_NO_ACTIVE_TURN_ERROR_MESSAGE
  );
}

/** Raised when a thread subscription may be live on a client OpenClaw no longer controls. */
export class CodexAppServerUnsafeSubscriptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexAppServerUnsafeSubscriptionError";
  }
}

export function isCodexAppServerUnsafeSubscriptionError(
  error: unknown,
): error is CodexAppServerUnsafeSubscriptionError {
  return error instanceof CodexAppServerUnsafeSubscriptionError;
}

/** Asserts Codex resumed the exact thread this attempt subscribed to. */
export function assertCodexThreadResumeSubscription(
  requestedThreadId: string,
  returnedThreadId: string,
): void {
  if (returnedThreadId !== requestedThreadId) {
    throw new CodexAppServerUnsafeSubscriptionError(
      `Codex thread/resume returned ${returnedThreadId} for ${requestedThreadId}`,
    );
  }
}

async function closeClientAndWaitIfAvailable(client: CodexAppServerClient): Promise<void> {
  const closeable = client as {
    close?: CodexAppServerClient["close"];
    closeAndWait?: CodexAppServerClient["closeAndWait"];
  };
  if (typeof closeable.closeAndWait === "function") {
    await closeable.closeAndWait();
    return;
  }
  closeable.close?.();
}

export async function closeCodexStartupClientBestEffort(
  client: CodexAppServerClient | undefined,
): Promise<void> {
  if (!client) {
    return;
  }
  const retiredSharedClient = retireSharedCodexAppServerClientIfCurrent(client);
  // Detached entries retain every ordinary and native lease; only isolated or
  // already-closed shared clients may be joined without aborting sibling turns.
  if (!retiredSharedClient || retiredSharedClient.closed) {
    await closeClientAndWaitIfAvailable(client);
  }
}

/** Retires an unsafe turn client without replacing an already-authoritative failure. */
export async function retireUnsafeCodexTurnClientBestEffort(
  client: CodexAppServerClient,
  operation: string,
): Promise<void> {
  try {
    await closeCodexStartupClientBestEffort(client);
  } catch (error) {
    embeddedAgentLog.debug("codex app-server unsafe turn client retirement failed", {
      operation,
      error,
    });
    try {
      client.close();
    } catch (closeError) {
      embeddedAgentLog.debug("codex app-server unsafe turn client close failed", {
        operation,
        error: closeError,
      });
    }
  }
}

/** Sends a bounded turn interrupt and waits for Codex to confirm terminal abort handling. */
export async function interruptCodexTurnAndWaitBestEffort(
  client: CodexAppServerClient,
  params: {
    threadId: string;
    turnId: string;
    timeoutMs?: number;
  },
): Promise<boolean> {
  const timeoutMs =
    params.timeoutMs && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
      ? params.timeoutMs
      : CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS;
  const requestParams = { threadId: params.threadId, turnId: params.turnId };
  let completion: { completion: Promise<boolean>; cancel: () => void } | undefined;
  try {
    // Codex acknowledges interruption before publishing turn/completed. Register
    // first so an immediate exact-turn terminal cannot race past its owner.
    completion = params.turnId
      ? getCodexAppServerTurnRouter(client).watchNativeTurnCompletion({
          threadId: params.threadId,
          turnId: params.turnId,
          timeoutMs,
        })
      : undefined;
    await client.request("turn/interrupt", requestParams, { timeoutMs });
    return completion ? await completion.completion : true;
  } catch (error) {
    if (isCodexAlreadyTerminalInterruptError(error)) {
      return true;
    }
    embeddedAgentLog.debug("codex app-server turn interrupt failed during abort", { error });
    return false;
  } finally {
    completion?.cancel();
  }
}

/** Unsubscribes from a thread while swallowing cleanup-only failures. */
export async function unsubscribeCodexThreadBestEffort(
  client: CodexAppServerClient,
  params: {
    threadId: string;
    timeoutMs: number;
    assertCurrent?: () => void;
  },
): Promise<boolean> {
  try {
    await unsubscribeCodexAppServerLiveThread(
      client,
      params.threadId,
      params.timeoutMs,
      params.assertCurrent,
    );
    return true;
  } catch (error) {
    params.assertCurrent?.();
    embeddedAgentLog.debug("codex app-server thread unsubscribe cleanup failed", {
      threadId: params.threadId,
      error,
    });
    return false;
  }
}

/**
 * Retires the shared client after a timed-out turn so later runs do not reuse a
 * potentially wedged app-server connection.
 */
export async function retireCodexAppServerClientAfterTimedOutTurn(
  client: CodexAppServerClient,
  params: {
    threadId: string;
    turnId: string;
    reason: string;
    /**
     * Only the terminal-idle watch proves the physical client is dead (zero
     * notifications for the whole window). Completion/assistant/budget
     * timeouts are per-turn conditions on a possibly healthy shared process —
     * failing co-leases for those would abort innocent sibling turns.
     */
    suspectPhysicalClient: boolean;
  },
): Promise<void> {
  const retiredSharedClient = retireSharedCodexAppServerClientIfCurrent(client, {
    failActiveLeases: params.suspectPhysicalClient,
  });
  const detachedSharedClient = Boolean(retiredSharedClient);
  const clientAlreadyClosed =
    params.suspectPhysicalClient && (retiredSharedClient?.closed ?? false);
  // Best-effort interrupt/unsubscribe only make sense while the transport is
  // still open; a suspect client was just closed (child gets SIGKILLed).
  if (!clientAlreadyClosed) {
    await interruptCodexTurnAndWaitBestEffort(client, {
      threadId: params.threadId,
      turnId: params.turnId,
      timeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
    });
    await unsubscribeCodexThreadBestEffort(client, {
      threadId: params.threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
    });
  }
  let closedClient = retiredSharedClient?.closed ?? false;
  if (!detachedSharedClient) {
    const close = (client as { close?: () => void }).close;
    if (typeof close === "function") {
      try {
        close.call(client);
        closedClient = true;
      } catch (error) {
        embeddedAgentLog.debug("codex app-server client close failed during timeout cleanup", {
          threadId: params.threadId,
          turnId: params.turnId,
          error,
        });
      }
    }
  }
  embeddedAgentLog.warn("codex app-server client retired after timed-out turn", {
    threadId: params.threadId,
    turnId: params.turnId,
    reason: params.reason,
    detachedSharedClient,
    closedClient,
    activeSharedClientLeases: retiredSharedClient?.activeLeases ?? 0,
  });
}
