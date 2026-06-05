/**
 * Best-effort cleanup helpers for timed-out or aborted Codex app-server turns.
 */
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import { retireSharedCodexAppServerClientIfCurrent } from "./shared-client.js";

/** Timeout for best-effort app-server turn interruption during cleanup. */
export const CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS = 5_000;
/** Timeout for best-effort thread unsubscribe during cleanup. */
export const CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS = 5_000;

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
): Promise<void> {
  try {
    await client.request(
      "thread/unsubscribe",
      { threadId: params.threadId },
      { timeoutMs: params.timeoutMs },
    );
  } catch (error) {
    embeddedAgentLog.debug("codex app-server thread unsubscribe cleanup failed", {
      threadId: params.threadId,
      error,
    });
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
  },
): Promise<void> {
  const retiredSharedClient = retireSharedCodexAppServerClientIfCurrent(client);
  const detachedSharedClient = Boolean(retiredSharedClient);
  interruptCodexTurnBestEffort(client, {
    threadId: params.threadId,
    turnId: params.turnId,
    timeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
  });
  await unsubscribeCodexThreadBestEffort(client, {
    threadId: params.threadId,
    timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  });
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
