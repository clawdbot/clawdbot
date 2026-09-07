/**
 * Sends typed JSON-RPC requests to the Codex app-server with sandbox guard
 * checks, shared-client leasing, and isolated-client shutdown handling.
 */
import type { resolveCodexAppServerAuthProfileIdForAgent } from "./auth-profile.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import type {
  CodexAppServerRequestMethod,
  CodexAppServerRequestParams,
  CodexAppServerRequestResult,
  JsonValue,
} from "./protocol.js";
import type { CodexAppServerClientOptions } from "./shared-client.js";
import { withTimeout } from "./timeout.js";

type CodexAppServerClientRequestParams = {
  client: CodexAppServerClient;
  method: string;
  requestParams?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  sessionKey?: string;
  sessionId?: string;
};

/** Sends one guarded request over a client lease owned by the caller. */
export async function requestCodexAppServerClientJson<T = JsonValue | undefined>(
  params: CodexAppServerClientRequestParams,
): Promise<T> {
  const { resolveCodexAppServerDirectSandboxBypassBlock } = await import("./sandbox-guard.js");
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
    params.client.request<T>(params.method, params.requestParams, {
      timeoutMs,
      signal: params.signal,
      ...(params.assertCurrent
        ? { assertCurrent: () => assertRequestOwnerCurrent(params.assertCurrent) }
        : {}),
    }),
    timeoutMs,
    `codex app-server ${params.method} timed out`,
  );
}

type CodexAppServerJsonClientOptions = Pick<
  CodexAppServerClientOptions,
  | "timeoutMs"
  | "pluginConfig"
  | "startOptions"
  | "authProfileId"
  | "authProfileStore"
  | "authBindingFingerprint"
  | "preparedAuth"
  | "authRequirement"
  | "agentDir"
  | "config"
> & {
  sessionKey?: string;
  sessionId?: string;
  isolated?: boolean;
  assertCurrent?: () => void;
};

/** Sends a typed Codex app-server request and returns the method-specific response shape. */
export async function requestCodexAppServerJson<M extends CodexAppServerRequestMethod>(
  params: CodexAppServerJsonClientOptions & {
    method: M;
    requestParams: CodexAppServerRequestParams<M>;
  },
): Promise<CodexAppServerRequestResult<M>>;
export async function requestCodexAppServerJson<T = JsonValue | undefined>(
  params: CodexAppServerJsonClientOptions & { method: string; requestParams?: unknown },
): Promise<T>;
export async function requestCodexAppServerJson<T = JsonValue | undefined>(
  params: CodexAppServerJsonClientOptions & { method: string; requestParams?: unknown },
): Promise<T> {
  // Fail closed before spawning or leasing a client for a guard-blocked method.
  const { resolveCodexAppServerDirectSandboxBypassBlock } = await import("./sandbox-guard.js");
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
  return await withCodexAppServerJsonClient(
    { ...params, timeoutMessage: `codex app-server ${params.method} timed out` },
    async (request) =>
      await request<T>({ method: params.method, requestParams: params.requestParams }),
  );
}

export type CodexAppServerScopedRequest = <T = JsonValue | undefined>(request: {
  method: string;
  requestParams?: unknown;
}) => Promise<T>;

/** A scoped guard rejected the request before a physical write. */
export class CodexAppServerScopedRequestRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexAppServerScopedRequestRejectedError";
  }
}

// Preserve pre-write rejection identity so callers do not retire a healthy shared client.
function assertRequestOwnerCurrent(assertCurrent?: () => void): void {
  try {
    assertCurrent?.();
  } catch (cause) {
    throw new CodexAppServerScopedRequestRejectedError(
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    );
  }
}

const CODEX_USAGE_ISOLATED_SHUTDOWN = { forceKillDelayMs: 200, exitTimeoutMs: 300 } as const;
const CODEX_ACCOUNT_READ_MAX_TIMEOUT_MS = 4_000;
const CODEX_ACCOUNT_READ_DEADLINE_MARGIN_MS = 250;
const CODEX_USAGE_DEADLINE_RESERVE_MS =
  CODEX_USAGE_ISOLATED_SHUTDOWN.forceKillDelayMs +
  CODEX_USAGE_ISOLATED_SHUTDOWN.exitTimeoutMs +
  CODEX_ACCOUNT_READ_DEADLINE_MARGIN_MS;

/** Reads rate limits and best-effort account identity from one isolated app-server session. */
export async function readCodexAppServerUsage(options: {
  timeoutMs: number;
  agentDir?: string;
  authProfileId?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  startOptions?: CodexAppServerStartOptions;
}): Promise<{ rateLimits: JsonValue; accountEmail?: string }> {
  const deadline = Date.now() + options.timeoutMs;
  return await withCodexAppServerJsonClient(
    {
      timeoutMs: options.timeoutMs,
      timeoutMessage: "codex app-server usage read timed out",
      agentDir: options.agentDir,
      ...(options.authProfileId ? { authProfileId: options.authProfileId } : {}),
      config: options.config,
      startOptions: options.startOptions,
      isolated: true,
      // A throwaway read-only child: bound shutdown inside the outer usage deadline.
      isolatedShutdown: CODEX_USAGE_ISOLATED_SHUTDOWN,
    },
    async (request) => {
      const rateLimits = await request<JsonValue>({ method: "account/rateLimits/read" });
      const accountEmail = await readCodexAccountEmailBestEffort(request, deadline);
      return { rateLimits, ...(accountEmail ? { accountEmail } : {}) };
    },
  );
}

function extractCodexAccountEmail(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { account?: unknown; email?: unknown; accountEmail?: unknown };
  const account =
    record.account && typeof record.account === "object"
      ? (record.account as { email?: unknown; accountEmail?: unknown })
      : record;
  const email = account.email ?? account.accountEmail;
  return typeof email === "string" && email.trim() ? email.trim() : undefined;
}

async function readCodexAccountEmailBestEffort(
  request: CodexAppServerScopedRequest,
  deadline: number,
): Promise<string | undefined> {
  const boundMs = Math.min(
    CODEX_ACCOUNT_READ_MAX_TIMEOUT_MS,
    deadline - Date.now() - CODEX_USAGE_DEADLINE_RESERVE_MS,
  );
  if (boundMs <= 0) {
    return undefined;
  }
  const read = request<unknown>({ method: "account/read", requestParams: {} }).then(
    (account) => extractCodexAccountEmail(account),
    () => undefined,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), boundMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Runs several guarded requests over one acquired client (shared lease or
 * isolated child) so related reads see the same app-server session. The whole
 * callback re-runs once when the client's start selection changed underneath it.
 */
export async function withCodexAppServerJsonClient<T>(
  params: CodexAppServerJsonClientOptions & {
    timeoutMessage?: string;
    // Bounds the isolated-client shutdown. Callers on a tight result deadline
    // pass a small budget so cleanup cannot breach the outer timeout; defaults
    // to the conservative graceful/force-kill window used elsewhere.
    isolatedShutdown?: { exitTimeoutMs?: number; forceKillDelayMs?: number };
  },
  run: (
    request: CodexAppServerScopedRequest,
    client: CodexAppServerClient,
    scope: { assertCurrent: () => void },
  ) => Promise<T>,
): Promise<T> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const timeoutMessage = params.timeoutMessage ?? "codex app-server request timed out";
  const timeoutController = new AbortController();
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
  const isPastDeadline = () => deadline !== undefined && Date.now() >= deadline;
  const throwIfAbandoned = () => {
    if (timeoutController.signal.aborted || isPastDeadline()) {
      throw new CodexAppServerScopedRequestRejectedError(timeoutMessage);
    }
  };
  const remainingTimeoutMs = () => {
    throwIfAbandoned();
    return deadline === undefined ? timeoutMs : Math.max(1, deadline - Date.now());
  };

  try {
    return await withTimeout(
      (async () => {
        const { resolveCodexAppServerDirectSandboxBypassBlock } =
          await import("./sandbox-guard.js");
        const {
          createIsolatedCodexAppServerClient,
          getLeasedSharedCodexAppServerClient,
          isCodexAppServerStartSelectionChangedError,
          releaseLeasedSharedCodexAppServerClient,
          retireSharedCodexAppServerClientIfCurrent,
        } = await import("./shared-client.js");
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
            authProfileStore: params.authProfileStore,
            authBindingFingerprint: params.authBindingFingerprint,
            preparedAuth: params.preparedAuth,
            authRequirement: params.authRequirement,
            agentDir: params.agentDir,
            config: params.config,
            abandonSignal: timeoutController.signal,
          });
          let scopeActive = true;
          const assertCurrent = () => {
            throwIfAbandoned();
            if (!scopeActive) {
              throw new CodexAppServerScopedRequestRejectedError(
                "Codex app-server request scope is closed",
              );
            }
            assertRequestOwnerCurrent(params.assertCurrent);
          };
          try {
            assertCurrent();
            const scopedRequest: CodexAppServerScopedRequest = async <R>(request: {
              method: string;
              requestParams?: unknown;
            }) => {
              const sandboxBlock = resolveCodexAppServerDirectSandboxBypassBlock({
                method: request.method,
                requestParams: request.requestParams,
                config: params.config,
                sessionKey: params.sessionKey,
                sessionId: params.sessionId,
              });
              if (sandboxBlock) {
                throw new CodexAppServerScopedRequestRejectedError(sandboxBlock);
              }
              assertCurrent();
              return await client.request<R>(request.method, request.requestParams, {
                timeoutMs: remainingTimeoutMs(),
                signal: timeoutController.signal,
                assertCurrent,
              });
            };
            return await run(scopedRequest, client, { assertCurrent });
          } catch (error) {
            if (!isCodexAppServerStartSelectionChangedError(error) || attempt > 0) {
              throw error;
            }
            if (!params.isolated) {
              retireSharedCodexAppServerClientIfCurrent(client);
            }
            throwIfAbandoned();
          } finally {
            scopeActive = false;
            if (params.isolated) {
              // Wait for the child to actually exit (with a SIGKILL fallback) so
              // the parent process doesn't hang on an orphaned codex app-server.
              // The stdio bin shim does not always propagate stdin EOF to the
              // underlying codex binary, so the unref'd close() path can leave
              // the child running and keep the parent's event loop alive.
              await client.closeAndWait({
                exitTimeoutMs: params.isolatedShutdown?.exitTimeoutMs ?? 2_000,
                forceKillDelayMs: params.isolatedShutdown?.forceKillDelayMs ?? 250,
              });
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
