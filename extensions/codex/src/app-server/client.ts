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
import {
  closeCodexAppServerTransport,
  closeCodexAppServerTransportAndWait,
  type CodexAppServerTransport,
} from "./transport.js";
import { MIN_CODEX_APP_SERVER_VERSION } from "./version.js";

export { MIN_CODEX_APP_SERVER_VERSION } from "./version.js";
const CODEX_APP_SERVER_PARSE_LOG_MAX = 500;
const CODEX_APP_SERVER_PARSE_BUFFER_MAX = 1_000_000;
const CODEX_APP_SERVER_PARSE_BUFFER_MAX_LINES = 1_000;
const CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS = 600_000;
const CODEX_APP_SERVER_STDERR_TAIL_MAX = 2_000;

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
    super(formatCodexAppServerRpcErrorMessage(error, method));
    this.name = "CodexAppServerRpcError";
    this.code = error.code;
    this.data = error.data;
  }
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

export function isCodexAppServerConnectionClosedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message === "codex app-server client is closed" ||
    error.message.startsWith("codex app-server exited:")
  );
}

type CodexServerRequestHandler = (
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
  private closeError: Error | undefined;
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
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString("utf8");
      this.stderrTail = appendBoundedTail(this.stderrTail, text, CODEX_APP_SERVER_STDERR_TAIL_MAX);
      const trimmed = text.trim();
      if (trimmed) {
        embeddedAgentLog.debug(`codex app-server stderr: ${trimmed}`);
      }
    });
    child.once("error", (error) =>
      this.closeWithError(error instanceof Error ? error : new Error(String(error))),
    );
    child.once("exit", (code, signal) => {
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
      return Promise.reject(this.closeError ?? new Error("codex app-server client is closed"));
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
    if (!this.markClosed(new Error("codex app-server client is closed"))) {
      return;
    }
    closeCodexAppServerTransport(this.child);
  }

  async closeAndWait(options?: {
    exitTimeoutMs?: number;
    forceKillDelayMs?: number;
  }): Promise<void> {
    this.markClosed(new Error("codex app-server client is closed"));
    await closeCodexAppServerTransportAndWait(this.child, options);
  }

  private writeMessage(message: RpcRequest | RpcResponse): void {
    if (this.closed) {
      return;
    }
    const id = "id" in message ? message.id : undefined;
    const method = "method" in message ? message.method : undefined;
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error?: Error | null) => {
      if (error) {
        embeddedAgentLog.warn("codex app-server write failed", { error, id, method });
      }
    });
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
      this.writeMessage({
        id: request.id,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async runServerRequestHandlers(
    request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
  ): Promise<JsonValue | undefined> {
    const timeoutResponse = timeoutServerRequestResponse(request);
    if (!timeoutResponse) {
      return await this.runServerRequestHandlersWithoutTimeout(request);
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.runServerRequestHandlersWithoutTimeout(request),
        new Promise<JsonValue>((resolve) => {
          timeout = setTimeout(() => {
            embeddedAgentLog.warn("codex app-server server request timed out", {
              id: request.id,
              method: request.method,
              timeoutMs: CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS,
            });
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
  ): Promise<JsonValue | undefined> {
    for (const handler of this.requestHandlers) {
      const result = await handler(request);
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

function assertSupportedCodexAppServerVersion(response: CodexInitializeResponse): void {
  const detectedVersion = readCodexVersionFromUserAgent(response.userAgent);
  if (!detectedVersion) {
    throw new Error(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required, but OpenClaw could not determine the running Codex version. Update the configured Codex app-server binary, or remove custom command overrides to use the managed binary.`,
    );
  }
  if (compareVersions(detectedVersion, MIN_CODEX_APP_SERVER_VERSION) < 0) {
    throw new Error(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required, but detected ${detectedVersion}. Update the configured Codex app-server binary, or remove custom command overrides to use the managed binary.`,
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
  const leftVersion = parseVersionForComparison(left);
  const rightVersion = parseVersionForComparison(right);
  const leftParts = leftVersion.parts;
  const rightParts = rightVersion.parts;
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  if (leftVersion.unstableSuffix && !rightVersion.unstableSuffix) {
    return -1;
  }
  if (!leftVersion.unstableSuffix && rightVersion.unstableSuffix) {
    return 1;
  }
  return 0;
}

function parseVersionForComparison(version: string): { parts: number[]; unstableSuffix: boolean } {
  // Same-version prerelease or build-suffixed versions do not satisfy a stable
  // protocol floor because important app-server contract changes can land
  // between alpha cuts and custom builds.
  const hasBuildMetadata = version.includes("+");
  const [withoutBuild = version] = version.split("+", 1);
  const prereleaseIndex = withoutBuild.indexOf("-");
  const numeric = prereleaseIndex >= 0 ? withoutBuild.slice(0, prereleaseIndex) : withoutBuild;
  return {
    parts: numeric
      .split(".")
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0)),
    unstableSuffix: prereleaseIndex >= 0 || hasBuildMetadata,
  };
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
    ? `${redacted.slice(0, CODEX_APP_SERVER_PARSE_LOG_MAX)}...`
    : redacted;
}

function appendBoundedTail(current: string, next: string, maxLength: number): string {
  const combined = `${current}${next}`;
  return combined.length > maxLength ? combined.slice(combined.length - maxLength) : combined;
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
  closeCodexAppServerTransportAndWait,
  CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS,
  redactCodexAppServerLinePreview,
} as const;
