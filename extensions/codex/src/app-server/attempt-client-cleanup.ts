/**
 * Best-effort cleanup helpers for Codex app-server startup attempts and turns.
 */
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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

/** Codex also reports this before an accepted turn publishes its start event. */
export function isCodexNoActiveTurnInterruptError(error: unknown): error is CodexAppServerRpcError {
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
    await client.closeAndWait();
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
  let cancelWatch: (() => void) | undefined;
  try {
    if (!params.turnId) {
      await client.request("turn/interrupt", requestParams, { timeoutMs });
      return true;
    }
    const deadline = Date.now() + timeoutMs;
    const started = createDeferred<boolean>();
    // Codex acknowledges interruption before publishing turn/completed. Register
    // first so an immediate exact-turn terminal cannot race past its owner.
    // Local yield can release its subscription before native cleanup finishes;
    // this watch belongs to the accepted turn, not that subscription route.
    const completion = getCodexAppServerTurnRouter(client).watchNativeTurnCompletion({
      threadId: params.threadId,
      turnId: params.turnId,
      timeoutMs,
      onStarted: () => started.resolve(true),
    });
    cancelWatch = completion.cancel;
    if (completion.state !== "pending") {
      return await completion.completion;
    }
    const requestInterrupt = async () => {
      try {
        await client.request("turn/interrupt", requestParams, {
          timeoutMs: Math.max(1, deadline - Date.now()),
          // The client floors RPC timeouts at 100ms. The lifecycle signal owns
          // the exact remaining deadline and cancels RPCs when terminal wins.
          signal: completion.settledSignal,
        });
        return true;
      } catch (error) {
        if (completion.state === "confirmed") {
          return true;
        }
        if (isCodexNoActiveTurnInterruptError(error)) {
          return false;
        }
        throw error;
      }
    };
    if (!(await requestInterrupt())) {
      // turn/start may acknowledge before native activation. Only that exact
      // start receipt permits another interrupt; absent-active is not terminal proof.
      const activated = await Promise.race([
        completion.completion.then(() => false),
        started.promise,
      ]);
      if (activated && completion.state === "pending" && Date.now() < deadline) {
        await requestInterrupt();
      }
    }
    return await completion.completion;
  } catch (error) {
    embeddedAgentLog.debug("codex app-server turn interrupt failed during abort", { error });
    return false;
  } finally {
    cancelWatch?.();
  }
}

/** Stops native terminals on the cancelled thread without retiring peer threads. */
export async function terminateCodexBackgroundTerminals(
  client: CodexAppServerClient,
  threadId: string,
): Promise<void> {
  const options = {
    timeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
    signal: AbortSignal.timeout(CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS),
  };
  try {
    // Codex returns the complete inventory when limit is omitted. Its process
    // IDs are thread-owned handles, not host PIDs or process-group authority.
    const { data } = await client.request("thread/backgroundTerminals/list", { threadId }, options);
    for (const { processId } of data) {
      // False also means it exited between listing and termination. The final
      // inventory distinguishes that benign race from a failed termination.
      await client.request(
        "thread/backgroundTerminals/terminate",
        { threadId, processId },
        options,
      );
    }
    if (data.length > 0) {
      const remaining = await client.request(
        "thread/backgroundTerminals/list",
        { threadId, limit: 1 },
        options,
      );
      if (remaining.data.length > 0) {
        throw new Error("native background terminals remain running");
      }
    }
  } catch (cause) {
    throw new Error(
      "Codex background-terminal cleanup failed; inspect the thread's running terminals before starting more work.",
      { cause },
    );
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
