/**
 * Best-effort cleanup helpers for Codex app-server startup attempts and turns.
 */
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import {
  clearSharedCodexAppServerClientIfCurrent,
  clearSharedCodexAppServerClientIfCurrentAndUnclaimed,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";

/** Timeout for best-effort app-server turn interruption during cleanup. */
export const CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS = 5_000;
/** Timeout for best-effort thread unsubscribe during cleanup. */
export const CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS = 5_000;

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
  const unclaimedSharedClient = clearSharedCodexAppServerClientIfCurrentAndUnclaimed(client);
  if (unclaimedSharedClient.closed) {
    await closeClientAndWaitIfAvailable(client);
    return;
  }
  if (unclaimedSharedClient.found) {
    const retired = retireSharedCodexAppServerClientIfCurrent(client);
    if (retired?.closed) {
      await closeClientAndWaitIfAvailable(client);
    }
    return;
  }
  const retiredSharedClient = retireSharedCodexAppServerClientIfCurrent(client);
  if (retiredSharedClient) {
    if (retiredSharedClient.closed) {
      await closeClientAndWaitIfAvailable(client);
    }
    return;
  }
  if (clearSharedCodexAppServerClientIfCurrent(client)) {
    await closeClientAndWaitIfAvailable(client);
    return;
  }
  await closeClientAndWaitIfAvailable(client);
}

/** Sends a turn interrupt without blocking abort cleanup on app-server errors. */
export function interruptCodexTurnBestEffort(
  client: CodexAppServerClient,
  params: {
    threadId: string;
    turnId: string;
    timeoutMs?: number;
  },
): void {
  const requestOptions =
    params.timeoutMs && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
      ? { timeoutMs: params.timeoutMs }
      : undefined;
  const requestParams = { threadId: params.threadId, turnId: params.turnId };
  try {
    const interrupt = requestOptions
      ? client.request("turn/interrupt", requestParams, requestOptions)
      : client.request("turn/interrupt", requestParams);
    void Promise.resolve(interrupt).catch((error: unknown) => {
      embeddedAgentLog.debug("codex app-server turn interrupt failed during abort", { error });
    });
  } catch (error) {
    embeddedAgentLog.debug("codex app-server turn interrupt failed during abort", { error });
  }
}

/** Unsubscribes from a thread while swallowing cleanup-only failures. */
export async function unsubscribeCodexThreadBestEffort(
  client: CodexAppServerClient,
  params: {
    threadId: string;
    timeoutMs: number;
  },
): Promise<boolean> {
  try {
    await client.request(
      "thread/unsubscribe",
      { threadId: params.threadId },
      { timeoutMs: params.timeoutMs },
    );
    return true;
  } catch (error) {
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
    interruptCodexTurnBestEffort(client, {
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
