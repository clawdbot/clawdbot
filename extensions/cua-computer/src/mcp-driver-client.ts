import { randomUUID } from "node:crypto";
import type { ActionResult } from "@trycua/cua-driver";
import type { mcpStdioRuntime } from "openclaw/plugin-sdk/agent-harness-runtime";
import { asOptionalRecord as record } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  ClickButton,
  EscalationReason,
  ScrollDirection,
  type CuaDriverSession,
  type CuaToolResult,
} from "./driver-client.js";

type McpStdioRuntime = Awaited<ReturnType<typeof mcpStdioRuntime.load>>;
type McpStdioClient = ReturnType<McpStdioRuntime["createMcpStdioClient"]>;
type McpStdioDecoder = NonNullable<
  ConstructorParameters<McpStdioRuntime["OpenClawStdioClientTransport"]>[0]["decoder"]
>;
type McpMessage = NonNullable<ReturnType<McpStdioDecoder["readMessage"]>>;

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_STARTUP_TIMEOUT_MS = 10_000;
const MCP_REQUEST_TIMEOUT_MS = 120_000;
const MAX_MCP_LINE_BYTES = 256 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 64;
const MAX_STDERR_BYTES = 32 * 1024;
const MCP_DESKTOP_TARGET = { kind: "desktop", display_id: "primary" } as const;

const ACTION_RESULT_TOOLS = new Set([
  "click",
  "double_click",
  "right_click",
  "scroll",
  "drag",
  "mouse_drag",
  "parallel_mouse_drag",
  "move_cursor",
  "mouse_button_down",
  "mouse_button_up",
  "type_text",
  "type_text_chars",
  "press_key",
  "hotkey",
  "set_value",
  "set_window_frame",
  "invoke_menu",
  "browser_click",
  "browser_pointer",
  "browser_type",
]);

type McpToolResult = {
  content?: Array<{ type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }>;
  isError?: unknown;
  structuredContent?: unknown;
};

function driverUnavailable(message: string, cause?: unknown): Error {
  return new Error(`COMPUTER_DRIVER_UNAVAILABLE: ${message}`, { cause });
}

function driverProtocolError(message: string, cause?: unknown): Error {
  return new Error(`COMPUTER_DRIVER_ERROR: ${message}`, { cause });
}

function mappedEnum(value: unknown, values: readonly string[], label: string): number {
  if (typeof value !== "string") {
    throw driverProtocolError(`CUA MCP ${label} is missing`);
  }
  const index = values.indexOf(value);
  if (index < 0) {
    throw driverProtocolError(`CUA MCP ${label} is invalid`);
  }
  return index;
}

function mcpActionResult(tool: string, structured: unknown): ActionResult | undefined {
  if (!ACTION_RESULT_TOOLS.has(tool)) {
    return undefined;
  }
  const value = record(structured);
  if (!value) {
    throw driverProtocolError(`CUA MCP ${tool} returned no ActionResult`);
  }
  const delivery = record(value.delivery);
  const escalation = record(value.escalation);
  const evidence = Array.isArray(value.evidence) ? value.evidence : undefined;
  return {
    effect: mappedEnum(
      value.effect,
      ["confirmed", "partial", "unverifiable", "suspected_noop", "refused"],
      "action effect",
    ),
    route: mappedEnum(
      value.route,
      ["accessibility", "synthetic_events", "global_input", "system_api", "dom", "trusted_input"],
      "action route",
    ),
    ...(delivery
      ? {
          delivery: {
            mode: mappedEnum(
              delivery.mode,
              ["background", "foreground", "not_applicable", "unknown"],
              "delivery mode",
            ),
            ...(typeof delivery.delivered_count === "number"
              ? { deliveredCount: delivery.delivered_count }
              : {}),
          },
        }
      : {}),
    ...(evidence
      ? {
          evidence: evidence.map((entry) => ({
            kind: mappedEnum(
              record(entry)?.kind,
              ["value_readback", "window_change"],
              "evidence kind",
            ),
          })),
        }
      : {}),
    ...(escalation
      ? {
          escalation: {
            target: mappedEnum(
              escalation.target,
              ["pixel", "foreground", "page", "session"],
              "escalation target",
            ),
            reason: mappedEnum(
              escalation.reason,
              [
                "route_unavailable",
                "delivery_failed",
                "effect_unconfirmed",
                "suspected_noop",
                "permission_required",
              ],
              "escalation reason",
            ),
          },
        }
      : {}),
  } as ActionResult;
}

function normalizeMcpToolResult(tool: string, raw: unknown): CuaToolResult {
  const value = record(raw) as McpToolResult | undefined;
  if (!value) {
    throw driverProtocolError(`CUA MCP ${tool} returned a non-object result`);
  }
  const content = Array.isArray(value.content) ? value.content : [];
  const text = content.flatMap((entry) =>
    entry?.type === "text" && typeof entry.text === "string" ? [entry.text] : [],
  );
  const images = content.flatMap((entry) =>
    entry?.type === "image" && typeof entry.data === "string" && typeof entry.mimeType === "string"
      ? [{ dataBase64: entry.data, mimeType: entry.mimeType }]
      : [],
  );
  const structured = record(value.structuredContent);
  const errorCode =
    typeof structured?.code === "string"
      ? structured.code
      : typeof record(structured?.refusal)?.code === "string"
        ? (record(structured?.refusal)?.code as string)
        : undefined;
  const isError = value.isError === true;
  return {
    text: text.join("\n"),
    images,
    ...(structured ? { structuredJson: JSON.stringify(structured) } : {}),
    isError,
    ...(errorCode ? { errorCode } : {}),
    ...(!isError ? { action: mcpActionResult(tool, structured) } : {}),
    degraded: structured?.degraded === true,
    rawJson: JSON.stringify(raw),
  };
}

class CuaMcpResponseDecoder implements McpStdioDecoder {
  private pending = Buffer.alloc(0);
  private pendingBytes = 0;
  private chunk: Buffer = Buffer.alloc(0);
  private cursor = 0;

  constructor(private readonly fail: (error: Error) => void) {}

  append(chunk: Buffer): void {
    if (this.pendingBytes + chunk.length > MAX_MCP_LINE_BYTES) {
      throw this.protocolError("CUA MCP response exceeded the line-size limit");
    }
    this.chunk = chunk;
    this.cursor = 0;
  }

  readMessage(): McpMessage | null {
    while (this.cursor < this.chunk.length) {
      const newline = this.chunk.indexOf(0x0a, this.cursor);
      if (newline < 0) {
        this.appendPending(this.chunk.subarray(this.cursor));
        this.chunk = Buffer.alloc(0);
        this.cursor = 0;
        return null;
      }
      let line = this.chunk.subarray(this.cursor, newline);
      this.cursor = newline + 1;
      if (this.pendingBytes > 0) {
        this.appendPending(line);
        line = this.pending.subarray(0, this.pendingBytes);
        this.pending = Buffer.alloc(0);
        this.pendingBytes = 0;
      }
      if (this.cursor === this.chunk.length) {
        this.chunk = Buffer.alloc(0);
        this.cursor = 0;
      }
      if (line.length === 0) {
        continue;
      }
      let response: Record<string, unknown> | undefined;
      try {
        response = record(JSON.parse(line.toString("utf8")));
      } catch (error) {
        throw this.protocolError("CUA MCP proxy returned invalid JSON", error);
      }
      if (response?.jsonrpc !== "2.0") {
        throw this.protocolError("CUA MCP proxy returned an invalid JSON-RPC version");
      }
      if (typeof response.id !== "number" || !Number.isSafeInteger(response.id)) {
        throw this.protocolError("CUA MCP proxy returned an invalid response id");
      }
      // Preserve CUA's response/error policy; SDK correlation sees a standard result envelope.
      return {
        jsonrpc: "2.0",
        id: response.id - 1,
        result: { value: response.result, error: response.error },
      };
    }
    return null;
  }

  clear(): void {
    this.pending = Buffer.alloc(0);
    this.pendingBytes = 0;
    this.chunk = Buffer.alloc(0);
    this.cursor = 0;
  }

  private appendPending(chunk: Buffer): void {
    const required = this.pendingBytes + chunk.length;
    if (required > this.pending.length) {
      const capacity = Math.min(MAX_MCP_LINE_BYTES, Math.max(required, this.pending.length * 2));
      const pending = Buffer.allocUnsafe(capacity);
      this.pending.copy(pending, 0, 0, this.pendingBytes);
      this.pending = pending;
    }
    chunk.copy(this.pending, this.pendingBytes);
    this.pendingBytes = required;
  }

  private protocolError(message: string, cause?: unknown): Error {
    const error = driverProtocolError(message, cause);
    this.fail(error);
    return error;
  }
}

type CuaMcpConnection = Pick<McpStdioClient, "request" | "isTimeout"> & {
  retire: () => Promise<void>;
  terminate: () => Promise<void>;
  dispose: () => Promise<"closed" | "uncertain">;
};

class CuaMcpProxyClient {
  private readonly startup: Promise<void>;
  private readonly ready: Promise<void>;
  private rejectFatal?: (error: Error) => void;
  private readonly fatal = new Promise<never>((_resolve, reject) => {
    this.rejectFatal = reject;
  });
  private readonly decoder = new CuaMcpResponseDecoder((error) => this.fail(error));
  private connection?: CuaMcpConnection;
  private shutdown?: Promise<void>;
  private inFlight = 0;
  private stderr = Buffer.alloc(0);
  private available = false;
  private failure: Error | undefined;
  private stopped = false;

  constructor(binaryPath: string, socketPath: string, env: NodeJS.ProcessEnv) {
    this.startup = this.initialize(binaryPath, socketPath, env);
    this.ready = Promise.race([this.startup, this.fatal]);
    void this.ready.catch(() => {});
  }

  isAvailable(): boolean {
    return this.available && !this.failure && !this.stopped;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CuaToolResult> {
    await this.ready;
    return normalizeMcpToolResult(
      name,
      await this.request("tools/call", { name, arguments: args }, MCP_REQUEST_TIMEOUT_MS, signal),
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.available = false;
    this.rejectFatal?.(driverUnavailable("CUA MCP proxy is stopping"));
    void this.connection?.retire().catch(() => undefined);
    this.beginShutdown();
    await this.startup.catch(() => undefined);
    await this.shutdown;
  }

  private async initialize(
    binaryPath: string,
    socketPath: string,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const proxyEnvironment = { ...env };
    for (const key of Object.keys(proxyEnvironment)) {
      if (key.startsWith("CUA_DRIVER_") || key === "CUA_TELEMETRY_ENABLED") {
        delete proxyEnvironment[key];
      }
    }
    // The normal Windows/Linux SDK route never loads the MCP runtime graph.
    const { mcpStdioRuntime } = await import("openclaw/plugin-sdk/agent-harness-runtime");
    const {
      createMcpStdioClient,
      OpenClawStdioClientTransport,
      connectMcpClient,
      disposeMcpClient,
    } = await mcpStdioRuntime.load();
    if (this.stopped) {
      throw driverUnavailable("CUA MCP proxy is stopping");
    }
    const owner = this;
    class CuaTransport extends OpenClawStdioClientTransport {
      override async send(message: McpMessage): Promise<void> {
        if ("method" in message && message.method === "notifications/cancelled") {
          return;
        }
        try {
          // Keep the proxy's one-based wire IDs while SDK correlation remains zero-based.
          await super.send(
            "id" in message && typeof message.id === "number"
              ? { ...message, id: message.id + 1 }
              : message,
          );
        } catch (error) {
          owner.fail(driverUnavailable("failed writing to CUA MCP proxy", error));
          throw error;
        }
      }
    }
    const transport = new CuaTransport({
      command: binaryPath,
      args: ["mcp", "--embedded", "--socket", socketPath],
      env: {
        ...proxyEnvironment,
        CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
        CUA_DRIVER_RS_UPDATE_CHECK: "false",
      },
      exactEnv: true,
      stderr: "pipe",
      decoder: this.decoder,
    });
    const protocol = createMcpStdioClient();
    const stderr = (chunk: Buffer) => {
      this.stderr = Buffer.concat([this.stderr, chunk]).subarray(-MAX_STDERR_BYTES);
    };
    transport.stderr?.on("data", stderr);
    const callbacks: Pick<typeof transport, "onerror" | "onexit"> = {
      onerror: (error) => this.fail(driverUnavailable("failed to start CUA MCP proxy", error)),
      onexit: ({ code, signal }) => {
        if (!this.stopped && !this.failure) {
          const detail = this.stderr.toString("utf8").trim();
          this.fail(
            driverUnavailable(
              `CUA MCP proxy exited (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
            ),
          );
        }
      },
    };
    Object.assign(transport, callbacks);
    this.connection = {
      request: protocol.request,
      retire: () => transport.retire(),
      terminate: () => transport.terminate(),
      dispose: () =>
        disposeMcpClient({
          client: protocol,
          transport,
          transportType: "stdio",
          detachStderr: () => {
            transport.stderr?.off("data", stderr);
          },
        }),
      isTimeout: protocol.isTimeout,
    };
    try {
      await connectMcpClient({
        client: {
          connect: async (target, options) => {
            const signal = options?.signal;
            const onAbort = () =>
              this.fail(
                driverUnavailable(`CUA MCP initialize timed out after ${MCP_STARTUP_TIMEOUT_MS}ms`),
              );
            signal?.addEventListener("abort", onAbort, { once: true });
            try {
              if (signal?.aborted) {
                onAbort();
                signal.throwIfAborted();
              }
              await protocol.connect(target);
              const initialized = record(
                await this.request(
                  "initialize",
                  {
                    protocolVersion: MCP_PROTOCOL_VERSION,
                    capabilities: {},
                    clientInfo: { name: "openclaw-cua-computer", version: "1" },
                  },
                  MCP_STARTUP_TIMEOUT_MS,
                ),
              );
              if (initialized?.protocolVersion !== MCP_PROTOCOL_VERSION) {
                throw driverProtocolError(
                  "CUA MCP proxy returned an incompatible protocol version",
                );
              }
              await protocol.notification("notifications/initialized", {});
              this.available = !this.stopped && !this.failure;
            } finally {
              signal?.removeEventListener("abort", onAbort);
            }
          },
          close: () => protocol.close(),
        },
        transport,
        timeoutMs: MCP_STARTUP_TIMEOUT_MS,
      });
    } catch (error) {
      this.fail(
        error instanceof Error ? error : driverUnavailable("failed to start CUA MCP proxy", error),
      );
      throw this.failure ?? error;
    }
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.failure) {
      throw this.failure;
    }
    if (this.stopped) {
      throw driverUnavailable("CUA MCP proxy is stopping");
    }
    if (signal?.aborted) {
      throw driverUnavailable("CUA MCP request was cancelled", signal.reason);
    }
    if (this.inFlight >= MAX_PENDING_REQUESTS) {
      throw driverUnavailable("CUA MCP proxy has too many pending requests");
    }
    const connection = this.connection;
    if (!connection) {
      throw driverUnavailable("CUA MCP proxy is not connected");
    }
    this.inFlight += 1;
    const onAbort = () =>
      this.fail(driverUnavailable("CUA MCP request was cancelled", signal?.reason));
    signal?.addEventListener("abort", onAbort, { once: true });
    let result: Record<string, unknown>;
    try {
      result = await connection.request(method, params, timeoutMs);
    } catch (error) {
      if (connection.isTimeout(error)) {
        this.fail(driverUnavailable(`CUA MCP ${method} timed out after ${timeoutMs}ms`));
      }
      throw this.failure ?? error;
    } finally {
      this.inFlight -= 1;
      signal?.removeEventListener("abort", onAbort);
    }
    if (result.error) {
      const error = record(result.error);
      const message = typeof error?.message === "string" ? error.message : "unknown JSON-RPC error";
      throw driverProtocolError(`CUA MCP request failed: ${message}`);
    }
    return result.value;
  }

  private fail(error: Error): void {
    if (this.failure || this.stopped) {
      return;
    }
    this.failure = error;
    this.available = false;
    this.rejectFatal?.(error);
    // Retirement clears the SDK request registry immediately; shutdown retains the process receipt.
    void this.connection?.terminate().catch(() => undefined);
    this.beginShutdown();
  }

  private beginShutdown(): void {
    if (!this.connection) {
      return;
    }
    this.shutdown ??= this.connection.dispose().then((outcome) => {
      if (outcome !== "closed") {
        throw driverUnavailable("CUA MCP proxy cleanup could not be confirmed");
      }
    });
    void this.shutdown.catch(() => {});
  }
}

function sessionState(value: CuaToolResult): import("@trycua/cua-driver").SessionStateOutput {
  if (value.isError || !value.structuredJson) {
    throw driverProtocolError(value.text || "CUA MCP session operation failed");
  }
  let structured: Record<string, unknown> | undefined;
  try {
    structured = record(JSON.parse(value.structuredJson));
  } catch (error) {
    throw driverProtocolError("CUA MCP session operation returned invalid JSON", error);
  }
  if (!structured) {
    throw driverProtocolError("CUA MCP session operation returned invalid state");
  }
  return {
    session: typeof structured.session === "string" ? structured.session : "",
    captureScope: mappedEnum(
      structured.capture_scope,
      ["auto", "window", "desktop"],
      "capture scope",
    ),
    effectiveScope: mappedEnum(
      structured.effective_scope,
      ["window", "desktop"],
      "effective scope",
    ),
    desktopUnlocked: structured.desktop_unlocked === true,
    ...(typeof structured.escalation_reason === "string"
      ? {
          escalationReason: mappedEnum(
            structured.escalation_reason,
            [
              "ax_tree_pixel_mismatch",
              "background_delivery_failed",
              "foreground_ineffective",
              "no_window_target",
              "other",
            ],
            "escalation reason",
          ),
        }
      : {}),
    ...(typeof structured.escalation_detail === "string"
      ? { escalationDetail: structured.escalation_detail }
      : {}),
  } as import("@trycua/cua-driver").SessionStateOutput;
}

class McpCuaDriverSession implements CuaDriverSession {
  readonly generation = randomUUID();
  private readonly publicSession = `openclaw-${randomUUID()}`;
  private startPromise: Promise<void> | undefined;
  private started = false;
  private disposed = false;

  constructor(private readonly client: CuaMcpProxyClient) {}

  isAvailable(): boolean {
    return !this.disposed && this.client.isAvailable();
  }

  resetAvailabilityCache(): void {}

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    return await this.sessionTool(name, args, signal);
  }

  async getCursorPosition(signal?: AbortSignal) {
    return await this.sessionTool("get_cursor_position", {}, signal);
  }

  async escalateScope(_reason: EscalationReason, signal?: AbortSignal) {
    const result = await this.sessionTool("get_session_state", {}, signal);
    return sessionState(result);
  }

  async getDesktopState(signal?: AbortSignal) {
    return await this.sessionTool("get_desktop_state", {}, signal);
  }

  async getScreenSize(signal?: AbortSignal) {
    return await this.sessionTool("get_screen_size", {}, signal);
  }

  async click(
    input: { x: number; y: number; button: ClickButton; count: number },
    signal?: AbortSignal,
  ) {
    return await this.sessionTool(
      "click",
      {
        x: input.x,
        y: input.y,
        button: ["left", "right", "middle"][input.button],
        count: input.count,
        target: MCP_DESKTOP_TARGET,
      },
      signal,
    );
  }

  async drag(
    input: { fromX: number; fromY: number; toX: number; toY: number; durationMs?: bigint },
    signal?: AbortSignal,
  ) {
    return await this.sessionTool(
      "drag",
      {
        from_x: input.fromX,
        from_y: input.fromY,
        to_x: input.toX,
        to_y: input.toY,
        ...(input.durationMs === undefined ? {} : { duration_ms: Number(input.durationMs) }),
        target: MCP_DESKTOP_TARGET,
      },
      signal,
    );
  }

  async moveCursor(input: { x: number; y: number }, signal?: AbortSignal) {
    return await this.sessionTool(
      "move_cursor",
      { x: input.x, y: input.y, target: MCP_DESKTOP_TARGET },
      signal,
    );
  }

  async scroll(
    input: { x: number; y: number; direction: ScrollDirection; amount: bigint },
    signal?: AbortSignal,
  ) {
    return await this.sessionTool(
      "scroll",
      {
        x: input.x,
        y: input.y,
        direction: ["up", "down", "left", "right"][input.direction],
        by: "line",
        amount: Number(input.amount),
        target: MCP_DESKTOP_TARGET,
      },
      signal,
    );
  }

  async typeText(text: string, signal?: AbortSignal) {
    return await this.sessionTool("type_text", { text, target: MCP_DESKTOP_TARGET }, signal);
  }

  async pressKey(input: { key: string; modifiers: string[] }, signal?: AbortSignal) {
    return await this.sessionTool(
      "press_key",
      { key: input.key, modifiers: input.modifiers, target: MCP_DESKTOP_TARGET },
      signal,
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    let failure: unknown;
    try {
      await this.startPromise;
    } catch (error) {
      failure = error;
    }
    if (this.client.isAvailable() && this.started) {
      try {
        await this.client.callTool("end_session", { session: this.publicSession });
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      await this.client.stop();
    } catch (error) {
      failure ??= error;
    }
    if (failure) {
      throw failure instanceof Error
        ? failure
        : driverUnavailable("CUA MCP cleanup failed", failure);
    }
  }

  private async sessionTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CuaToolResult> {
    await this.ensureStarted(signal);
    return await this.client.callTool(name, { ...args, session: this.publicSession }, signal);
  }

  private async ensureStarted(signal?: AbortSignal): Promise<void> {
    if (this.disposed) {
      throw driverUnavailable("cua-computer is stopping");
    }
    if (!this.startPromise) {
      const start = this.client
        .callTool("start_session", { session: this.publicSession }, signal)
        .then((result) => {
          if (result.isError) {
            throw driverProtocolError(result.text || "CUA MCP start_session failed");
          }
          this.started = true;
        });
      this.startPromise = start;
      try {
        await start;
      } catch (error) {
        if (this.startPromise === start) {
          this.startPromise = undefined;
        }
        throw error;
      }
      return;
    }
    await this.startPromise;
  }
}

export function createCuaMcpDriver(options: {
  binaryPath: string;
  socketPath: string;
  env?: NodeJS.ProcessEnv;
}): CuaDriverSession {
  return new McpCuaDriverSession(
    new CuaMcpProxyClient(options.binaryPath, options.socketPath, options.env ?? process.env),
  );
}
