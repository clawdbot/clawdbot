import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { embeddedAgentLog, OPENCLAW_VERSION } from "openclaw/plugin-sdk/agent-harness-runtime";
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
import { closeCodexAppServerTransport, type CodexAppServerTransport } from "./transport.js";

export const MIN_CODEX_APP_SERVER_VERSION = "0.118.0";
const CODEX_APP_SERVER_PARSE_LOG_MAX = 500;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

export class CodexAppServerRpcError extends Error {
  readonly code?: number;
  readonly data?: JsonValue;

  constructor(error: { code?: number; message: string; data?: JsonValue }, method: string) {
    super(error.message || `${method} failed`);
    this.name = "CodexAppServerRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

export type CodexServerRequestHandler = (
  request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
) => Promise<JsonValue | undefined> | JsonValue | undefined;

export type CodexServerNotificationHandler = (
  notification: CodexServerNotification,
) => Promise<void> | void;

export class CodexAppServerClient {
  private readonly child: CodexAppServerTransport;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly requestHandlers = new Set<CodexServerRequestHandler>();
  private readonly notificationHandlers = new Set<CodexServerNotificationHandler>();
  private readonly closeHandlers = new Set<(client: CodexAppServerClient) => void>();
  private nextId = 1;
  private initialized = false;
  private closed = false;

  private constructor(child: CodexAppServerTransport) {
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        embeddedAgentLog.debug(`codex app-server stderr: ${text}`);
      }
    });
    child.once("error", (error) =>
      this.closeWithError(error instanceof Error ? error : new Error(String(error))),
    );
    child.once("exit", (code, signal) => {
      this.closeWithError(
        new Error(
          `codex app-server exited: code=${formatExitValue(code)} signal=${formatExitValue(signal)}`,
        ),
      );
    });
    // Guard against unhandled EPIPE / write-after-close errors on the stdin
    // stream. When the child process terminates abruptly the pipe can break
    // before the "exit" event fires, so a pending writeMessage() produces an
    // asynchronous error on stdin that would otherwise crash the gateway.
    child.stdin.on?.("error", (error) =>
      this.closeWithError(error instanceof Error ? error : new Error(String(error))),
    );
  }

  static start(options?: Partial<CodexAppServerStartOptions>): CodexAppServerClient {
    const defaults = resolveCodexAppServerRuntimeOptions().start;
    const startOptions = {
      ...defaults,
      ...options,
      headers: options?.headers ?? defaults.headers,
    };
    if (startOptions.transport === "websocket") {
      return new CodexAppServerClient(createWebSocketTransport(startOptions));
    }
    return new CodexAppServerClient(createStdioTransport(startOptions));
  }

  static fromTransportForTests(child: CodexAppServerTransport): CodexAppServerClient {
    return new CodexAppServerClient(child);
  }

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
    assertSupportedCodexAppServerVersion(response);
    this.notify("initialized");
    this.initialized = true;
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
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    options ??= {};
    if (this.closed) {
      return Promise.reject(new Error("codex app-server client is closed"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new Error(`${method} aborted`));
    }
    const id = this.nextId++;
    const message: RpcRequest = { id, method, params: params as JsonValue | undefined };
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let cleanupAbort: (() => void) | undefined;
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
        reject(error);
      };
      if (options.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
        timeout = setTimeout(
          () => rejectPending(new Error(`${method} timed out`)),
          Math.max(100, options.timeoutMs),
        );
        timeout.unref?.();
      }
      if (options.signal) {
        const abortListener = () => rejectPending(new Error(`${method} aborted`));
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
          reject(error);
        },
        cleanup,
      });
      if (options.signal?.aborted) {
        rejectPending(new Error(`${method} aborted`));
        return;
      }
      try {
        this.writeMessage(message);
      } catch (error) {
        rejectPending(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: JsonValue): void {
    this.writeMessage({ method, params });
  }

  addRequestHandler(handler: CodexServerRequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  addNotificationHandler(handler: CodexServerNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  addCloseHandler(handler: (client: CodexAppServerClient) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.lines.close();
    this.rejectPendingRequests(new Error("codex app-server client is closed"));
    closeCodexAppServerTransport(this.child);
  }

  private writeMessage(message: RpcRequest | RpcResponse): void {
    if (this.closed) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      embeddedAgentLog.warn("failed to parse codex app-server message", {
        error,
        linePreview: redactCodexAppServerLinePreview(trimmed),
      });
      return;
    }
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
      for (const handler of this.requestHandlers) {
        const result = await handler(request);
        if (result !== undefined) {
          this.writeMessage({ id: request.id, result });
          return;
        }
      }
      this.writeMessage({ id: request.id, result: defaultServerRequestResponse(request) });
    } catch (error) {
      this.writeMessage({
        id: request.id,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private handleNotification(notification: CodexServerNotification): void {
    for (const handler of this.notificationHandlers) {
      Promise.resolve(handler(notification)).catch((error: unknown) => {
        embeddedAgentLog.warn("codex app-server notification handler failed", { error });
      });
    }
  }

  private closeWithError(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.lines.close();
    this.rejectPendingRequests(error);
    closeCodexAppServerTransport(this.child);
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

export function defaultServerRequestResponse(
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
  if (isCodexAppServerApprovalRequest(request.method)) {
    return {
      decision: "decline",
      reason: "OpenClaw codex app-server bridge does not grant native approvals yet.",
    };
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

function assertSupportedCodexAppServerVersion(response: CodexInitializeResponse): void {
  const detectedVersion = readCodexVersionFromUserAgent(response.userAgent);
  if (!detectedVersion) {
    throw new Error(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required, but OpenClaw could not determine the running Codex version. Upgrade Codex CLI and retry.`,
    );
  }
  if (compareVersions(detectedVersion, MIN_CODEX_APP_SERVER_VERSION) < 0) {
    throw new Error(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required, but detected ${detectedVersion}. Upgrade Codex CLI and retry.`,
    );
  }
}

export function readCodexVersionFromUserAgent(userAgent: string | undefined): string | undefined {
  // Codex returns `<originator>/<codex-version> ...`; the originator can be
  // OpenClaw, Codex Desktop, or an env override, so only the slash-delimited
  // version in the leading product field is stable.
  const match = userAgent?.match(
    /^[^/]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:[\s(]|$)/,
  );
  return match?.[1];
}

function compareVersions(left: string, right: string): number {
  const leftParts = numericVersionParts(left);
  const rightParts = numericVersionParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

function numericVersionParts(version: string): number[] {
  // Pre-release/build tags do not affect our minimum gate; 0.118.0-dev should
  // satisfy the same protocol floor as 0.118.0.
  return version
    .split(/[+-]/, 1)[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function redactCodexAppServerLinePreview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const redacted = compact
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1<redacted>")
    .replace(
      /("(?:api_?key|authorization|token|access_token|refresh_token)"\s*:\s*")([^"]+)(")/gi,
      "$1<redacted>$3",
    );
  return redacted.length > CODEX_APP_SERVER_PARSE_LOG_MAX
    ? `${redacted.slice(0, CODEX_APP_SERVER_PARSE_LOG_MAX)}...`
    : redacted;
}

const CODEX_APP_SERVER_APPROVAL_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

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

export const __testing = {
  closeCodexAppServerTransport,
  redactCodexAppServerLinePreview,
} as const;
