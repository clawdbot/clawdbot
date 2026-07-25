/**
 * JSON-RPC client for Codex app-server transports, including request/response
 * routing, notification fanout, server request handlers, and version checks.
 */
import { randomUUID } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { embeddedAgentLog, OPENCLAW_VERSION } from "openclaw/plugin-sdk/agent-harness-runtime";
import { sliceUtf16Safe, truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { parse as parseSemver } from "semver";
import { resolveCodexAppServerRuntimeOptions, type CodexAppServerStartOptions } from "./config.js";
import {
  type CodexAppServerRequestMethod,
  type CodexAppServerRequestParams,
  type CodexAppServerRequestResult,
  type CodexInitializeParams,
  type CodexInitializeResponse,
  isRpcResponse,
  type CodexServerNotification,
  type JsonValue,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
} from "./protocol.js";
import { createStdioTransport } from "./transport-stdio.js";
import { createWebSocketTransport } from "./transport-websocket.js";
import {
  closeCodexAppServerTransport,
  closeCodexAppServerTransportAndWait,
  type CodexAppServerTransport,
} from "./transport.js";
import { MAX_CODEX_APP_SERVER_VERSION, MIN_CODEX_APP_SERVER_VERSION } from "./version.js";

/** Minimum supported Codex app-server version exported for callers/tests. */
const CODEX_APP_SERVER_PARSE_LOG_MAX = 500;
const CODEX_APP_SERVER_PARSE_BUFFER_MAX = 8 * 1024 * 1024;
const CODEX_APP_SERVER_PARSE_BUFFER_MAX_LINES = 1_000;
// agents_wait can use a 600s inner budget plus 30s handler grace. Keep the
// app-server request guard outside that window so Codex receives the tool result.
const CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS = 660_000;
const CODEX_APP_SERVER_STDERR_TAIL_MAX = 2_000;
const CODEX_APP_SERVER_OVERLOADED_ERROR_CODE = -32_001;
const CODEX_APP_SERVER_OVERLOAD_MAX_RETRIES = 3;
const CODEX_APP_SERVER_OVERLOAD_RETRY_BASE_MS = 50;
const CODEX_APP_SERVER_CLIENT_INSTANCE_IDS = new WeakMap<object, string>();
const UNPAIRED_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

/** Process-local generation fence for bindings tied to one app-server client instance. */
export function getCodexAppServerClientInstanceId(client: object): string {
  const current = CODEX_APP_SERVER_CLIENT_INSTANCE_IDS.get(client);
  if (current) {
    return current;
  }
  const created = randomUUID();
  CODEX_APP_SERVER_CLIENT_INSTANCE_IDS.set(client, created);
  return created;
}

export function resolveCodexAppServerClientInstanceId(client: object): string {
  const getInstanceId = (client as { getInstanceId?: () => string }).getInstanceId;
  return getInstanceId?.call(client) ?? getCodexAppServerClientInstanceId(client);
}

/** RPC error wrapper that preserves app-server error code and data. */
export class CodexAppServerRpcError extends Error {
  readonly code?: number;
  readonly data?: JsonValue;
  readonly method: string;

  constructor(error: { code?: number; message: string; data?: JsonValue }, method: string) {
    super(formatCodexAppServerRpcErrorMessage(error, method));
    this.name = "CodexAppServerRpcError";
    this.code = error.code;
    this.data = error.data;
    this.method = method;
  }
}

class CodexAppServerLocalRequestCancellationError extends Error {
  readonly code = "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED";

  constructor(
    method: string,
    readonly reason: "aborted" | "timed out",
    readonly mayHaveWritten: boolean,
  ) {
    super(`${method} ${reason}`);
    this.name = "CodexAppServerLocalRequestCancellationError";
  }
}

export function isCodexAppServerRequestTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED" &&
    "reason" in error &&
    error.reason === "timed out"
  );
}

export function isCodexAppServerBrokenPipeError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && current.code === "EPIPE") {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

class CodexAppServerIndeterminateTransportError extends Error {
  readonly code = "CODEX_APP_SERVER_REQUEST_TRANSPORT_INDETERMINATE";
  readonly mayHaveWritten = true;

  constructor(method: string, cause: Error) {
    super(`${method} transport failed after request write: ${cause.message}`, { cause });
    this.name = "CodexAppServerIndeterminateTransportError";
  }
}

/** True when a local cancellation can leave an app-server request in flight. */
export function isCodexAppServerIndeterminateRequestCancellationError(
  error: unknown,
): error is Error & { code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED"; mayHaveWritten: true } {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED" &&
    "mayHaveWritten" in error &&
    error.mayHaveWritten === true
  );
}

/** True when local cancellation happened before a request write was attempted. */
export function isCodexAppServerPrewriteRequestCancellationError(
  error: unknown,
): error is Error & { code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED"; mayHaveWritten: false } {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED" &&
    "mayHaveWritten" in error &&
    error.mayHaveWritten === false
  );
}

/** True when transport failure cannot prove a written request stopped running. */
export function isCodexAppServerIndeterminateTransportError(error: unknown): error is Error & {
  code: "CODEX_APP_SERVER_REQUEST_TRANSPORT_INDETERMINATE";
  mayHaveWritten: true;
} {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "CODEX_APP_SERVER_REQUEST_TRANSPORT_INDETERMINATE" &&
    "mayHaveWritten" in error &&
    error.mayHaveWritten === true
  );
}

function formatCodexAppServerRpcErrorMessage(
  error: { message: string; data?: JsonValue },
  method: string,
): string {
  const message = error.message || `${method} failed`;
  const detail = readCodexAppServerRpcReloginDetail(error.data);
  return detail && !message.includes(detail) ? `${message}: ${detail}` : message;
}

function readCodexAppServerRpcReloginDetail(data: JsonValue | undefined): string | undefined {
  const record = isJsonObject(data) ? data : undefined;
  const nested = isJsonObject(record?.error) ? record.error : record;
  if (!nested) {
    return undefined;
  }
  const isRelogin =
    nested.action === "relogin" ||
    (nested.reason === "cloudRequirements" && nested.errorCode === "Auth");
  const detail = typeof nested.detail === "string" ? nested.detail.trim() : "";
  return isRelogin && detail ? detail : undefined;
}

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Returns true for errors that mean the app-server transport is closed. */
export function isCodexAppServerConnectionClosedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (isCodexAppServerIndeterminateTransportError(error)) {
    return true;
  }
  return (
    error.message === "codex app-server client is closed" ||
    error.message.startsWith("codex app-server exited:")
  );
}

type CodexServerRequestHandler = (
  request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
  signal?: AbortSignal,
) => Promise<JsonValue | undefined> | JsonValue | undefined;

/** Notification handler registered on a Codex app-server client. */
type CodexServerNotificationHandler = (
  notification: CodexServerNotification,
) => Promise<void> | void;

/** Runtime identity returned by the Codex app-server initialize handshake. */
export type CodexAppServerRuntimeIdentity = {
  serverVersion: string;
  userAgent?: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
};

/** Stateful app-server JSON-RPC client over stdio or websocket transport. */
export class CodexAppServerClient {
  private readonly instanceId = randomUUID();
  private readonly child: CodexAppServerTransport;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly requestHandlers = new Set<CodexServerRequestHandler>();
  private readonly notificationHandlers = new Set<CodexServerNotificationHandler>();
  private readonly closeHandlers = new Set<(client: CodexAppServerClient) => void>();
  private nextId = 1;
  private initialized = false;
  private closed = false;
  private transportExited = false;
  private closeError: Error | undefined;
  private serverVersion: string | undefined;
  private runtimeIdentity: CodexAppServerRuntimeIdentity | undefined;
  private threadSessionRequestGuard:
    | ((options: {
        signal?: AbortSignal;
        timeoutMs?: number;
        timeoutMessage: string;
        abortMessage: string;
      }) => Promise<() => void>)
    | undefined;
  private stderrTail = "";
  private pendingParse:
    | {
        text: string;
        lineCount: number;
        firstError: unknown;
      }
    | undefined;

  private constructor(child: CodexAppServerTransport) {
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.lines.on("error", (error) =>
      this.closeWithError(error instanceof Error ? error : new Error(String(error))),
    );
    child.stdout.on("error", (error) =>
      this.closeWithError(error instanceof Error ? error : new Error(String(error))),
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => {
      this.stderrTail = appendBoundedTail(this.stderrTail, text, CODEX_APP_SERVER_STDERR_TAIL_MAX);
      const trimmed = text.trim();
      if (trimmed) {
        embeddedAgentLog.debug(`codex app-server stderr: ${trimmed}`);
      }
    });
    // Codex reserves stderr for diagnostics; losing that stream must not tear
    // down an otherwise healthy JSON-RPC connection on stdout.
    child.stderr.on("error", (error) => {
      embeddedAgentLog.warn("codex app-server stderr stream failed", { error });
    });
    child.once("error", (error) =>
      this.closeWithError(error instanceof Error ? error : new Error(String(error))),
    );
    child.once("exit", (code, signal) => {
      this.transportExited = true;
      this.closeWithError(buildCodexAppServerExitError(code, signal, this.stderrTail));
    });
    // Guard against unhandled EPIPE / write-after-close errors on the stdin
    // stream. When the child process terminates abruptly the pipe can break
    // before the "exit" event fires, so a pending writeMessage() produces an
    // asynchronous error on stdin that would otherwise crash the gateway.
    child.stdin.on?.("error", (error) =>
      this.closeWithError(error instanceof Error ? error : new Error(String(error))),
    );
  }

  /** Starts a new app-server client using resolved runtime start options. */
  static start(options?: Partial<CodexAppServerStartOptions>): CodexAppServerClient {
    const defaults = resolveCodexAppServerRuntimeOptions().start;
    const startOptions = {
      ...defaults,
      ...options,
      headers: options?.headers ?? defaults.headers,
    };
    if (startOptions.transport === "stdio" && startOptions.commandSource === "managed") {
      throw new Error("Managed Codex app-server start options must be resolved before spawn.");
    }
    if (startOptions.transport === "websocket" || startOptions.transport === "unix") {
      return new CodexAppServerClient(createWebSocketTransport(startOptions));
    }
    return new CodexAppServerClient(createStdioTransport(startOptions));
  }

  /** Builds a client around a fake transport for tests. */
  static fromTransportForTests(child: CodexAppServerTransport): CodexAppServerClient {
    return new CodexAppServerClient(child);
  }

  /** Performs the app-server initialize handshake and validates protocol version. */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    // The handshake identifies the exact app-server process we will keep using,
    // which matters when callers override the binary or app-server args.
    const response = await this.request("initialize", {
      clientInfo: {
        name: "openclaw",
        title: "OpenClaw",
        version: OPENCLAW_VERSION,
      },
      capabilities: {
        experimentalApi: true,
      },
    } satisfies CodexInitializeParams);
    this.serverVersion = assertSupportedCodexAppServerVersion(response);
    this.runtimeIdentity = buildCodexAppServerRuntimeIdentity(response, this.serverVersion);
    this.notify("initialized");
    this.initialized = true;
  }

  /** Returns the version detected during initialize. */
  getServerVersion(): string | undefined {
    return this.serverVersion;
  }

  /** Returns runtime metadata detected during initialize. */
  getRuntimeIdentity(): CodexAppServerRuntimeIdentity | undefined {
    return this.runtimeIdentity ? { ...this.runtimeIdentity } : undefined;
  }

  /** Stable generation id for this exact physical client instance. */
  getInstanceId(): string {
    return this.instanceId;
  }

  /** Installs the spawn-owner check run before config-loading thread requests. */
  setThreadSessionRequestGuard(
    guard:
      | ((options: {
          signal?: AbortSignal;
          timeoutMs?: number;
          timeoutMessage: string;
          abortMessage: string;
        }) => Promise<() => void>)
      | undefined,
  ): void {
    this.threadSessionRequestGuard = guard;
  }

  /** Returns the local transport PID for scoped child-process cleanup, when available. */
  getTransportPid(): number | undefined {
    return this.child.pid;
  }

  request<M extends CodexAppServerRequestMethod>(
    method: M,
    params: CodexAppServerRequestParams<M>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<CodexAppServerRequestResult<M>>;
  request<T = JsonValue | undefined>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T>;
  request<T = JsonValue | undefined>(
    method: string,
    params?: unknown,
    optionsInput?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    let options = optionsInput;
    options ??= {};
    if (this.closed) {
      return Promise.reject(this.closeError ?? new Error("codex app-server client is closed"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(
        new CodexAppServerLocalRequestCancellationError(method, "aborted", false),
      );
    }
    const guard =
      method === "thread/start" || method === "thread/resume" || method === "thread/fork"
        ? this.threadSessionRequestGuard
        : undefined;
    if (guard) {
      if (
        !options.signal &&
        !(
          options.timeoutMs !== undefined &&
          Number.isFinite(options.timeoutMs) &&
          options.timeoutMs > 0
        )
      ) {
        return Promise.reject(
          new TypeError(`${method} requires a positive finite timeout or abort signal`),
        );
      }
      return (async () => {
        const guardStartedAt = Date.now();
        const timeoutMessage = `${method} timed out`;
        const abortMessage = `${method} aborted`;
        let releaseGuard: () => void;
        try {
          releaseGuard = await guard({
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            timeoutMessage,
            abortMessage,
          });
        } catch (error) {
          if (error instanceof Error && error.message === timeoutMessage) {
            throw new CodexAppServerLocalRequestCancellationError(method, "timed out", false);
          }
          if (error instanceof Error && error.message === abortMessage) {
            throw new CodexAppServerLocalRequestCancellationError(method, "aborted", false);
          }
          throw error;
        }
        let released = false;
        const release = () => {
          if (released) {
            return;
          }
          released = true;
          releaseGuard();
        };
        let releaseWhenRequestSettles = true;
        let requestMayHaveWritten = false;
        try {
          const elapsedMs = Date.now() - guardStartedAt;
          const remainingTimeoutMs =
            options.timeoutMs === undefined ? undefined : options.timeoutMs - elapsedMs;
          if (remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) {
            throw new CodexAppServerLocalRequestCancellationError(method, "timed out", false);
          }
          return await this.requestWithoutThreadSessionGuard<T>(
            method,
            params,
            {
              ...options,
              ...(remainingTimeoutMs !== undefined ? { timeoutMs: remainingTimeoutMs } : {}),
            },
            () => {
              requestMayHaveWritten = true;
            },
          );
        } catch (error) {
          if (requestMayHaveWritten && !(error instanceof CodexAppServerRpcError)) {
            // A local deadline cannot prove Codex stopped loading native config.
            // Keep the fence until the physical process exits, even if shutdown
            // itself outlives closeAndWait's bounded wait.
            releaseWhenRequestSettles = false;
            await this.closeAndRunAfterExit(release, method);
          }
          throw error;
        } finally {
          if (releaseWhenRequestSettles) {
            release();
          }
        }
      })();
    }
    return this.requestWithoutThreadSessionGuard<T>(method, params, options);
  }

  private requestWithoutThreadSessionGuard<T>(
    method: string,
    params: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal },
    onWriteAttempt?: () => void,
  ): Promise<T> {
    return this.requestWithOverloadRetry(method, params, options, onWriteAttempt);
  }

  private async requestWithOverloadRetry<T>(
    method: string,
    params: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal },
    onWriteAttempt?: () => void,
  ): Promise<T> {
    const deadline =
      options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)
        ? Date.now() + options.timeoutMs
        : undefined;
    for (let retry = 0; ; retry += 1) {
      if (options.signal?.aborted) {
        throw new CodexAppServerLocalRequestCancellationError(method, "aborted", false);
      }
      const remainingTimeoutMs = deadline === undefined ? undefined : deadline - Date.now();
      if (remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) {
        throw new CodexAppServerLocalRequestCancellationError(method, "timed out", false);
      }
      try {
        return await this.requestOnce<T>(
          method,
          params,
          {
            ...options,
            ...(remainingTimeoutMs !== undefined ? { timeoutMs: remainingTimeoutMs } : {}),
          },
          onWriteAttempt,
        );
      } catch (error) {
        // Codex emits -32001 only when ingress rejects a request before enqueue,
        // so retrying mutating methods cannot duplicate server-side work.
        if (
          !(error instanceof CodexAppServerRpcError) ||
          error.code !== CODEX_APP_SERVER_OVERLOADED_ERROR_CODE ||
          retry >= CODEX_APP_SERVER_OVERLOAD_MAX_RETRIES
        ) {
          throw error;
        }
        const backoffMs = Math.round(
          CODEX_APP_SERVER_OVERLOAD_RETRY_BASE_MS * 2 ** retry * (0.75 + Math.random() * 0.5),
        );
        await this.waitForOverloadRetry(method, backoffMs, deadline, options.signal);
      }
    }
  }

  private async waitForOverloadRetry(
    method: string,
    backoffMs: number,
    deadline: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (signal?.aborted) {
      throw new CodexAppServerLocalRequestCancellationError(method, "aborted", false);
    }
    const remainingMs = deadline === undefined ? undefined : deadline - Date.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      throw new CodexAppServerLocalRequestCancellationError(method, "timed out", false);
    }
    const delayMs = remainingMs === undefined ? backoffMs : Math.min(backoffMs, remainingMs);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, delayMs);
      timer.unref?.();
      const abortListener = () => {
        cleanup();
        reject(new CodexAppServerLocalRequestCancellationError(method, "aborted", false));
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortListener);
      };
      signal?.addEventListener("abort", abortListener, { once: true });
      if (signal?.aborted) {
        abortListener();
      }
    });
  }

  private requestOnce<T>(
    method: string,
    params: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal },
    onWriteAttempt?: () => void,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(this.closeError ?? new Error("codex app-server client is closed"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(
        new CodexAppServerLocalRequestCancellationError(method, "aborted", false),
      );
    }
    const id = this.nextId++;
    const message: RpcRequest = { id, method, params: params as JsonValue | undefined };
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let cleanupAbort: (() => void) | undefined;
      let mayHaveWritten = false;
      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        cleanupAbort?.();
        cleanupAbort = undefined;
      };
      const rejectPending = (error: Error) => {
        if (!this.pending.has(id)) {
          return;
        }
        this.pending.delete(id);
        cleanup();
        reject(
          mayHaveWritten &&
            !(error instanceof CodexAppServerRpcError) &&
            !isCodexAppServerIndeterminateRequestCancellationError(error) &&
            !isCodexAppServerIndeterminateTransportError(error)
            ? new CodexAppServerIndeterminateTransportError(method, error)
            : error,
        );
      };
      if (options.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
        timeout = setTimeout(
          () =>
            rejectPending(
              new CodexAppServerLocalRequestCancellationError(method, "timed out", mayHaveWritten),
            ),
          Math.max(100, options.timeoutMs),
        );
        timeout.unref?.();
      }
      if (options.signal) {
        const abortListener = () =>
          rejectPending(
            new CodexAppServerLocalRequestCancellationError(method, "aborted", mayHaveWritten),
          );
        options.signal.addEventListener("abort", abortListener, { once: true });
        cleanupAbort = () => options.signal?.removeEventListener("abort", abortListener);
      }
      this.pending.set(id, {
        method,
        resolve: (value) => {
          cleanup();
          resolve(value as T);
        },
        reject: (error) => {
          cleanup();
          reject(
            mayHaveWritten &&
              !(error instanceof CodexAppServerRpcError) &&
              !isCodexAppServerIndeterminateRequestCancellationError(error) &&
              !isCodexAppServerIndeterminateTransportError(error)
              ? new CodexAppServerIndeterminateTransportError(method, error)
              : error,
          );
        },
        cleanup,
      });
      if (options.signal?.aborted) {
        rejectPending(new CodexAppServerLocalRequestCancellationError(method, "aborted", false));
        return;
      }
      try {
        mayHaveWritten = true;
        onWriteAttempt?.();
        this.writeMessage(message, (error) => rejectPending(error));
      } catch (error) {
        rejectPending(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Sends a fire-and-forget JSON-RPC notification to the app-server. */
  notify(method: string, params?: JsonValue): void {
    this.writeMessage({ method, params });
  }

  /** Registers a handler for app-server requests sent back to OpenClaw. */
  addRequestHandler(handler: CodexServerRequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  /** Registers a notification handler and returns its disposer. */
  addNotificationHandler(handler: CodexServerNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /** Registers a close handler and returns its disposer. */
  addCloseHandler(handler: (client: CodexAppServerClient) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** Closes the transport without waiting for process/socket shutdown. */
  close(): void {
    if (!this.markClosed(new Error("codex app-server client is closed"))) {
      return;
    }
    closeCodexAppServerTransport(this.child);
  }

  /** Closes the transport and waits for shutdown according to transport policy. */
  async closeAndWait(options?: {
    exitTimeoutMs?: number;
    forceKillDelayMs?: number;
  }): Promise<boolean> {
    this.markClosed(new Error("codex app-server client is closed"));
    return await closeCodexAppServerTransportAndWait(this.child, options);
  }

  /** Closes this transport and runs cleanup only after physical process exit. */
  async closeAndRunAfterExit(onExit: () => void, operation: string): Promise<void> {
    let settled = false;
    const runOnExit = () => {
      if (settled) {
        return;
      }
      settled = true;
      onExit();
    };
    if (this.transportExited) {
      runOnExit();
      return;
    }
    this.child.once("exit", runOnExit);
    try {
      if (await this.closeAndWait()) {
        this.child.off?.("exit", runOnExit);
        runOnExit();
      }
    } catch (closeError) {
      embeddedAgentLog.warn("codex app-server shutdown after indeterminate request failed", {
        closeError,
        operation,
      });
    }
  }

  private writeMessage(message: RpcRequest | RpcResponse, onError?: (error: Error) => void): void {
    if (this.closed) {
      return;
    }
    const id = "id" in message ? message.id : undefined;
    const method = "method" in message ? message.method : undefined;
    this.child.stdin.write(
      `${stringifyCodexAppServerMessage(message)}\n`,
      (error?: Error | null) => {
        if (error) {
          embeddedAgentLog.warn("codex app-server write failed", { error, id, method });
          onError?.(error);
        }
      },
    );
  }

  private handleLine(line: string): void {
    const rawLine = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (this.pendingParse) {
      this.handlePendingParseLine(rawLine);
      return;
    }
    const trimmed = rawLine.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      if (shouldBufferCodexAppServerParseFailure(trimmed, error)) {
        this.pendingParse = { text: trimmed, lineCount: 1, firstError: error };
        return;
      }
      logCodexAppServerParseFailure(trimmed, error, 1);
      return;
    }
    this.handleParsedMessage(parsed);
  }

  private handlePendingParseLine(line: string): void {
    const pending = this.pendingParse;
    if (!pending) {
      return;
    }
    const candidate = `${pending.text}\\n${line}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      const lineCount = pending.lineCount + 1;
      if (
        shouldBufferCodexAppServerParseFailure(candidate.trim(), error) &&
        candidate.length <= CODEX_APP_SERVER_PARSE_BUFFER_MAX &&
        lineCount <= CODEX_APP_SERVER_PARSE_BUFFER_MAX_LINES
      ) {
        this.pendingParse = { text: candidate, lineCount, firstError: pending.firstError };
        return;
      }
      this.pendingParse = undefined;
      logCodexAppServerParseFailure(candidate, error, lineCount);
      return;
    }
    this.pendingParse = undefined;
    this.handleParsedMessage(parsed);
  }

  private handleParsedMessage(parsed: unknown): void {
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    const message = parsed as RpcMessage;
    if (isRpcResponse(message)) {
      this.handleResponse(message);
      return;
    }
    if (!("method" in message)) {
      return;
    }
    if ("id" in message && message.id !== undefined) {
      void this.handleServerRequest({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      return;
    }
    this.handleNotification({
      method: message.method,
      params: message.params,
    });
  }

  private handleResponse(response: RpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new CodexAppServerRpcError(response.error, pending.method));
      return;
    }
    pending.resolve(response.result);
  }

  private async handleServerRequest(
    request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
  ): Promise<void> {
    try {
      const result = await this.runServerRequestHandlers(request);
      if (result !== undefined) {
        this.writeMessage({ id: request.id, result });
        return;
      }
      this.writeMessage({ id: request.id, result: defaultServerRequestResponse(request) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      embeddedAgentLog.warn("codex app-server server request handler failed", {
        id: request.id,
        method: request.method,
        error,
      });
      this.writeMessage({
        id: request.id,
        error: {
          code: -32603,
          message,
        },
      });
    }
  }

  private async runServerRequestHandlers(
    request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
  ): Promise<JsonValue | undefined> {
    const controller = new AbortController();
    const timeoutResponse = timeoutServerRequestResponse(request);
    if (!timeoutResponse) {
      return await this.runServerRequestHandlersWithoutTimeout(request, controller.signal);
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.runServerRequestHandlersWithoutTimeout(request, controller.signal),
        new Promise<JsonValue>((resolve) => {
          timeout = setTimeout(() => {
            embeddedAgentLog.warn("codex app-server server request timed out", {
              id: request.id,
              method: request.method,
              timeoutMs: CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS,
            });
            controller.abort(new Error("codex app-server server request timed out"));
            resolve(timeoutResponse);
          }, CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async runServerRequestHandlersWithoutTimeout(
    request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
    signal: AbortSignal,
  ): Promise<JsonValue | undefined> {
    for (const handler of this.requestHandlers) {
      if (signal.aborted) {
        return undefined;
      }
      const result = await handler(request, signal);
      if (result !== undefined) {
        return result;
      }
    }
    return undefined;
  }

  private handleNotification(notification: CodexServerNotification): void {
    for (const handler of this.notificationHandlers) {
      Promise.resolve(handler(notification)).catch((error: unknown) => {
        embeddedAgentLog.warn("codex app-server notification handler failed", { error });
      });
    }
  }

  private closeWithError(error: Error): void {
    if (this.markClosed(error)) {
      closeCodexAppServerTransport(this.child);
    }
  }

  private markClosed(error: Error): boolean {
    if (this.closed) {
      return false;
    }
    this.closed = true;
    this.closeError = error;
    this.lines.close();
    this.rejectPendingRequests(error);
    return true;
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) {
      handler(this);
    }
  }
}

function defaultServerRequestResponse(
  request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
): JsonValue {
  if (request.method === "item/tool/call") {
    return {
      contentItems: [
        {
          type: "inputText",
          text: "OpenClaw did not register a handler for this app-server tool call.",
        },
      ],
      success: false,
    };
  }
  if (
    request.method === "item/commandExecution/requestApproval" ||
    request.method === "item/fileChange/requestApproval"
  ) {
    return { decision: "decline" };
  }
  if (request.method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  if (request.method === "item/tool/requestUserInput") {
    return {
      answers: {},
    };
  }
  if (request.method === "mcpServer/elicitation/request") {
    return {
      action: "decline",
    };
  }
  return {};
}

function stringifyCodexAppServerMessage(message: RpcRequest | RpcResponse): string {
  return (
    JSON.stringify(message, (_key, value) =>
      typeof value === "string" ? value.replace(UNPAIRED_SURROGATE_RE, "") : value,
    ) ?? "null"
  );
}

function timeoutServerRequestResponse(
  request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
): JsonValue | undefined {
  if (request.method !== "item/tool/call") {
    return undefined;
  }
  return {
    contentItems: [
      {
        type: "inputText",
        text: `OpenClaw dynamic tool call timed out after ${CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS}ms before sending a response to Codex.`,
      },
    ],
    success: false,
  };
}

/** Raised when the initialize handshake detects an unsupported app-server version. */
class CodexAppServerVersionError extends Error {
  readonly detectedVersion?: string;

  constructor(detectedVersion: string | undefined) {
    const detected = detectedVersion
      ? `detected ${detectedVersion}`
      : "OpenClaw could not determine the running Codex version";
    super(
      `A stable Codex app-server from ${MIN_CODEX_APP_SERVER_VERSION} through ${MAX_CODEX_APP_SERVER_VERSION} is required, but ${detected}. Update the configured Codex app-server binary, or remove custom command overrides to use the managed binary.`,
    );
    this.name = "CodexAppServerVersionError";
    this.detectedVersion = detectedVersion;
  }
}

function assertSupportedCodexAppServerVersion(response: CodexInitializeResponse): string {
  const detectedVersion = readCodexVersionFromUserAgent(response.userAgent);
  const parsedVersion = parseSemver(detectedVersion ?? "");
  if (
    !detectedVersion ||
    !parsedVersion ||
    parsedVersion.compare(MIN_CODEX_APP_SERVER_VERSION) < 0 ||
    parsedVersion.compare(MAX_CODEX_APP_SERVER_VERSION) > 0 ||
    // Generated schemas cover stable releases only; prereleases and custom builds can drift.
    parsedVersion.prerelease.length > 0 ||
    parsedVersion.build.length > 0
  ) {
    throw new CodexAppServerVersionError(detectedVersion);
  }
  return detectedVersion;
}

export function isUnsupportedCodexAppServerVersionError(error: unknown): boolean {
  return error instanceof CodexAppServerVersionError;
}

function buildCodexAppServerRuntimeIdentity(
  response: CodexInitializeResponse,
  serverVersion: string,
): CodexAppServerRuntimeIdentity {
  const userAgent = readNonEmptyInitializeString(response.userAgent);
  const codexHome = readNonEmptyInitializeString(response.codexHome);
  const platformFamily = readNonEmptyInitializeString(response.platformFamily);
  const platformOs = readNonEmptyInitializeString(response.platformOs);
  return {
    serverVersion,
    ...(userAgent ? { userAgent } : {}),
    ...(codexHome ? { codexHome } : {}),
    ...(platformFamily ? { platformFamily } : {}),
    ...(platformOs ? { platformOs } : {}),
  };
}

function readNonEmptyInitializeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Extracts the Codex version from the app-server initialize user-agent field. */
function readCodexVersionFromUserAgent(userAgent: string | undefined): string | undefined {
  // Codex returns `<originator>/<codex-version> ...`; the originator can be
  // OpenClaw, Codex Desktop, or an env override, so only the slash-delimited
  // version in the leading product field is stable.
  const match = userAgent?.match(
    /^[^/]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:[\s(]|$)/,
  );
  return match?.[1];
}

function redactCodexAppServerLinePreview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const redacted = compact
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1<redacted>")
    .replace(
      /("(?:api_?key|authorization|token|access_token|refresh_token)"\s*:\s*")([^"]+)(")/gi,
      "$1<redacted>$3",
    )
    .replace(
      /\b([a-z0-9_]*(?:api_?key|authorization|access_token|refresh_token|token))(\s*=\s*)(["']?)[^\s"']+(\3)/gi,
      "$1$2$3<redacted>$4",
    );
  return redacted.length > CODEX_APP_SERVER_PARSE_LOG_MAX
    ? `${truncateUtf16Safe(redacted, CODEX_APP_SERVER_PARSE_LOG_MAX)}...`
    : redacted;
}

function appendBoundedTail(current: string, next: string, maxLength: number): string {
  const combined = `${current}${next}`;
  return combined.length > maxLength ? sliceUtf16Safe(combined, -maxLength) : combined;
}

function buildCodexAppServerExitError(code: unknown, signal: unknown, stderrTail: string): Error {
  const stderrPreview = redactCodexAppServerLinePreview(stderrTail);
  const suffix = stderrPreview ? ` stderr=${JSON.stringify(stderrPreview)}` : "";
  return new Error(
    `codex app-server exited: code=${formatExitValue(code)} signal=${formatExitValue(
      signal,
    )}${suffix}`,
  );
}

// Codex has emitted JSON with raw newlines inside string values, which breaks
// line framing. Buffer the fragments and re-join with an escaped newline so
// the message parses; bounded by CODEX_APP_SERVER_PARSE_BUFFER_MAX*.
function shouldBufferCodexAppServerParseFailure(value: string, error: unknown): boolean {
  if (!value.startsWith("{") && !value.startsWith("[")) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Unterminated string") || message.includes("Unexpected end of JSON input")
  );
}

function logCodexAppServerParseFailure(value: string, error: unknown, fragmentCount: number): void {
  const linePreview = redactCodexAppServerLinePreview(value);
  const suffix = fragmentCount > 1 ? ` fragments=${fragmentCount}` : "";
  embeddedAgentLog.warn("failed to parse codex app-server message", {
    error,
    errorMessage: error instanceof Error ? error.message : String(error),
    fragmentCount,
    linePreview,
    consoleMessage: `failed to parse codex app-server message${suffix}: preview=${JSON.stringify(
      linePreview,
    )}`,
  });
}

const CODEX_APP_SERVER_APPROVAL_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

/** Returns true for app-server approval request methods OpenClaw can answer. */
export function isCodexAppServerApprovalRequest(method: string): boolean {
  return CODEX_APP_SERVER_APPROVAL_REQUEST_METHODS.has(method);
}

function formatExitValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return "unknown";
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
