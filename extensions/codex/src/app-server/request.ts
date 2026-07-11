/**
 * Sends typed JSON-RPC requests to the Codex app-server with sandbox guard
 * checks, shared-client leasing, and isolated-client shutdown handling.
 */
import type { resolveCodexAppServerAuthProfileIdForAgent } from "./auth-bridge.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import type {
  CodexAppServerRequestMethod,
  CodexAppServerRequestParams,
  CodexAppServerRequestResult,
  JsonValue,
} from "./protocol.js";
import { resolveCodexAppServerDirectSandboxBypassBlock } from "./sandbox-guard.js";
import {
  createIsolatedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
  isCodexAppServerStartSelectionChangedError,
  releaseLeasedSharedCodexAppServerClient,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { withTimeout } from "./timeout.js";

type CodexAppServerClientRequestParams = {
  client: CodexAppServerClient;
  method: string;
  requestParams?: unknown;
  timeoutMs?: number;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  sessionKey?: string;
  sessionId?: string;
};

/** Sends one guarded request over a client lease owned by the caller. */
export async function requestCodexAppServerClientJson<T = JsonValue | undefined>(
  params: CodexAppServerClientRequestParams,
): Promise<T> {
  const sandboxBlock = resolveCodexAppServerDirectSandboxBypassBlock({
    method: params.method,
    requestParams: params.requestParams,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
  });
  if (sandboxBlock) {
    throw new Error(sandboxBlock);
  }
  const timeoutMs = params.timeoutMs ?? 60_000;
  return await withTimeout(
    params.client.request<T>(params.method, params.requestParams, { timeoutMs }),
    timeoutMs,
    `codex app-server ${params.method} timed out`,
  );
}

/** Sends a typed Codex app-server request and returns the method-specific response shape. */
export async function requestCodexAppServerJson<M extends CodexAppServerRequestMethod>(params: {
  method: M;
  requestParams: CodexAppServerRequestParams<M>;
  timeoutMs?: number;
  pluginConfig?: unknown;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  sessionKey?: string;
  sessionId?: string;
  isolated?: boolean;
}): Promise<CodexAppServerRequestResult<M>>;
export async function requestCodexAppServerJson<T = JsonValue | undefined>(params: {
  method: string;
  requestParams?: unknown;
  timeoutMs?: number;
  pluginConfig?: unknown;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  sessionKey?: string;
  sessionId?: string;
  isolated?: boolean;
}): Promise<T>;
export async function requestCodexAppServerJson<T = JsonValue | undefined>(params: {
  method: string;
  requestParams?: unknown;
  timeoutMs?: number;
  pluginConfig?: unknown;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  sessionKey?: string;
  sessionId?: string;
  isolated?: boolean;
}): Promise<T> {
  const sandboxBlock = resolveCodexAppServerDirectSandboxBypassBlock({
    method: params.method,
    requestParams: params.requestParams,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
  });
  if (sandboxBlock) {
    throw new Error(sandboxBlock);
  }
  const timeoutMs = params.timeoutMs ?? 60_000;
  const timeoutMessage = `codex app-server ${params.method} timed out`;
  const timeoutController = new AbortController();
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
  const isPastDeadline = () => deadline !== undefined && Date.now() >= deadline;
  const throwIfAbandoned = () => {
    if (timeoutController.signal.aborted || isPastDeadline()) {
      throw new Error(timeoutMessage);
    }
  };
  const remainingTimeoutMs = () => {
    throwIfAbandoned();
    return deadline === undefined ? timeoutMs : Math.max(1, deadline - Date.now());
  };

  try {
    return await withTimeout(
      (async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          throwIfAbandoned();
          const acquireClient = params.isolated
            ? createIsolatedCodexAppServerClient
            : getLeasedSharedCodexAppServerClient;
          const client = await acquireClient({
            startOptions: params.startOptions,
            pluginConfig: params.pluginConfig,
            timeoutMs: remainingTimeoutMs(),
            authProfileId: params.authProfileId,
            agentDir: params.agentDir,
            config: params.config,
            abandonSignal: timeoutController.signal,
          });
          try {
            throwIfAbandoned();
            return await client.request<T>(params.method, params.requestParams, {
              timeoutMs: remainingTimeoutMs(),
              signal: timeoutController.signal,
            });
          } catch (error) {
            if (!isCodexAppServerStartSelectionChangedError(error) || attempt > 0) {
              throw error;
            }
            if (!params.isolated) {
              retireSharedCodexAppServerClientIfCurrent(client);
            }
            throwIfAbandoned();
          } finally {
            if (params.isolated) {
              // Wait for the child to actually exit (with a SIGKILL fallback) so
              // the parent process doesn't hang on an orphaned codex app-server.
              // The stdio bin shim does not always propagate stdin EOF to the
              // underlying codex binary, so the unref'd close() path can leave
              // the child running and keep the parent's event loop alive.
              await client.closeAndWait({ exitTimeoutMs: 2_000, forceKillDelayMs: 250 });
            } else {
              releaseLeasedSharedCodexAppServerClient(client);
            }
          }
        }
        throw new Error("Codex app-server selection retry loop exited unexpectedly");
      })(),
      timeoutMs,
      timeoutMessage,
    );
  } catch (error) {
    if (isPastDeadline()) {
      throw new Error(timeoutMessage, { cause: error });
    }
    throw error;
  } finally {
    // `withTimeout` only stops awaiting. Abort the shared operation before its
    // timeout becomes observable so no delayed acquire can issue a request or retry.
    timeoutController.abort();
  }
}
