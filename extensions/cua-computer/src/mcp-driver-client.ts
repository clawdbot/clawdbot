import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ActionResult } from "@trycua/cua-driver";
import { asOptionalRecord as record } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  ClickButton,
  EscalationReason,
  ScrollDirection,
  type CuaDriverSession,
  type CuaToolResult,
} from "./driver-client.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_STARTUP_TIMEOUT_MS = 10_000;
const MCP_REQUEST_TIMEOUT_MS = 120_000;
const MCP_SHUTDOWN_TIMEOUT_MS = 2_000;
const MAX_MCP_LINE_BYTES = 256 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 64;
const MAX_STDERR_BYTES = 32 * 1024;

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

type JsonRpcResponse = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
};

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

class CuaMcpProxyClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly ready: Promise<void>;
  private nextId = 0;
  private stdout = Buffer.alloc(0);
  private stderr = Buffer.alloc(0);
  private available = false;
  private failure: Error | undefined;
  private stopped = false;

  constructor(binaryPath: string, socketPath: string, env: NodeJS.ProcessEnv) {
    const proxyEnvironment = { ...env };
    for (const key of Object.keys(proxyEnvironment)) {
      if (key.startsWith("CUA_DRIVER_") || key === "CUA_TELEMETRY_ENABLED") {
        delete proxyEnvironment[key];
      }
    }
    this.child = spawn(binaryPath, ["mcp", "--embedded", "--socket", socketPath], {
      env: {
        ...proxyEnvironment,
        CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
        CUA_DRIVER_RS_UPDATE_CHECK: "false",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = Buffer.concat([this.stderr, chunk]).subarray(-MAX_STDERR_BYTES);
    });
    this.child.once("error", (error) =>
      this.fail(driverUnavailable("failed to start CUA MCP proxy", error)),
    );
    this.child.once("exit", (code, signal) => {
      if (!this.stopped) {
        const detail = this.stderr.toString("utf8").trim();
        this.fail(
          driverUnavailable(
            `CUA MCP proxy exited (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
          ),
        );
      }
    });
    this.ready = this.initialize();
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
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.available = false;
    this.rejectPending(driverUnavailable("CUA MCP proxy is stopping"));
    this.child.stdin.end();
    if (await this.waitForExit(MCP_SHUTDOWN_TIMEOUT_MS)) {
      return;
    }
    this.child.kill("SIGTERM");
    if (await this.waitForExit(MCP_SHUTDOWN_TIMEOUT_MS)) {
      return;
    }
    this.child.kill("SIGKILL");
  }

  private async initialize(): Promise<void> {
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
      throw driverProtocolError("CUA MCP proxy returned an incompatible protocol version");
    }
    this.notify("notifications/initialized", {});
    this.available = true;
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (this.stopped) {
      return Promise.reject(driverUnavailable("CUA MCP proxy is stopping"));
    }
    if (signal?.aborted) {
      return Promise.reject(driverUnavailable("CUA MCP request was cancelled", signal.reason));
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(driverUnavailable("CUA MCP proxy has too many pending requests"));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(driverUnavailable(`CUA MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      const pending: PendingRequest = { resolve, reject, timer, signal };
      if (signal) {
        pending.onAbort = () =>
          this.fail(driverUnavailable("CUA MCP request was cancelled", signal.reason));
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending.set(id, pending);
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(value: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error) {
        this.fail(driverUnavailable("failed writing to CUA MCP proxy", error));
      }
    });
  }

  private handleStdout(chunk: Buffer): void {
    if (this.failure || this.stopped) {
      return;
    }
    this.stdout = Buffer.concat([this.stdout, chunk]);
    if (this.stdout.length > MAX_MCP_LINE_BYTES) {
      this.fail(driverProtocolError("CUA MCP response exceeded the line-size limit"));
      return;
    }
    while (true) {
      const newline = this.stdout.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      const line = this.stdout.subarray(0, newline);
      this.stdout = this.stdout.subarray(newline + 1);
      if (line.length === 0) {
        continue;
      }
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line.toString("utf8")) as JsonRpcResponse;
      } catch (error) {
        this.fail(driverProtocolError("CUA MCP proxy returned invalid JSON", error));
        return;
      }
      if (response.jsonrpc !== "2.0") {
        this.fail(driverProtocolError("CUA MCP proxy returned an invalid JSON-RPC version"));
        return;
      }
      if (typeof response.id !== "number" || !Number.isSafeInteger(response.id)) {
        this.fail(driverProtocolError("CUA MCP proxy returned an invalid response id"));
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) {
        continue;
      }
      this.pending.delete(response.id);
      this.clearPending(pending);
      if (response.error) {
        const message =
          typeof response.error.message === "string"
            ? response.error.message
            : "unknown JSON-RPC error";
        pending.reject(driverProtocolError(`CUA MCP request failed: ${message}`));
      } else {
        pending.resolve(response.result);
      }
    }
  }

  private fail(error: Error): void {
    if (this.failure || this.stopped) {
      return;
    }
    this.failure = error;
    this.available = false;
    this.rejectPending(error);
    this.child.kill("SIGTERM");
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      this.clearPending(pending);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private clearPending(pending: PendingRequest): void {
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.child.removeListener("exit", onExit);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      this.child.once("exit", onExit);
    });
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
  private readonly windowPublicSession = `openclaw-window-${randomUUID()}`;
  private readonly desktopPublicSession = `openclaw-desktop-${randomUUID()}`;
  private windowStartPromise: Promise<void> | undefined;
  private desktopStartPromise: Promise<void> | undefined;
  private windowStarted = false;
  private desktopStarted = false;
  private disposed = false;

  constructor(private readonly client: CuaMcpProxyClient) {}

  isAvailable(): boolean {
    return !this.disposed && this.client.isAvailable();
  }

  resetAvailabilityCache(): void {}

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    await this.ensureStarted("window", signal);
    return await this.client.callTool(name, { ...args, session: this.windowPublicSession }, signal);
  }

  async callDesktopTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    return await this.desktopTool(name, args, signal);
  }

  async escalateScope(_reason: EscalationReason, signal?: AbortSignal) {
    await this.ensureStarted("desktop", signal);
    const result = await this.client.callTool(
      "get_session_state",
      { session: this.desktopPublicSession },
      signal,
    );
    return sessionState(result);
  }

  async getDesktopState(signal?: AbortSignal) {
    return await this.desktopTool("get_desktop_state", {}, signal);
  }

  async getScreenSize(signal?: AbortSignal) {
    return await this.desktopTool("get_screen_size", {}, signal);
  }

  async click(
    input: { x: number; y: number; button: ClickButton; count: number },
    signal?: AbortSignal,
  ) {
    return await this.desktopTool(
      "click",
      {
        x: input.x,
        y: input.y,
        button: ["left", "right", "middle"][input.button],
        count: input.count,
        scope: "desktop",
      },
      signal,
    );
  }

  async drag(
    input: { fromX: number; fromY: number; toX: number; toY: number; durationMs?: bigint },
    signal?: AbortSignal,
  ) {
    return await this.desktopTool(
      "drag",
      {
        from_x: input.fromX,
        from_y: input.fromY,
        to_x: input.toX,
        to_y: input.toY,
        ...(input.durationMs === undefined ? {} : { duration_ms: Number(input.durationMs) }),
        scope: "desktop",
      },
      signal,
    );
  }

  async moveCursor(input: { x: number; y: number }, signal?: AbortSignal) {
    return await this.desktopTool(
      "move_cursor",
      { x: input.x, y: input.y, scope: "desktop" },
      signal,
    );
  }

  async scroll(
    input: { x: number; y: number; direction: ScrollDirection; amount: bigint },
    signal?: AbortSignal,
  ) {
    return await this.desktopTool(
      "scroll",
      {
        x: input.x,
        y: input.y,
        direction: ["up", "down", "left", "right"][input.direction],
        by: "line",
        amount: Number(input.amount),
        scope: "desktop",
      },
      signal,
    );
  }

  async typeText(text: string, signal?: AbortSignal) {
    return await this.desktopTool("type_text", { text, scope: "desktop" }, signal);
  }

  async pressKey(input: { key: string; modifiers: string[] }, signal?: AbortSignal) {
    return await this.desktopTool(
      "press_key",
      { key: input.key, modifiers: input.modifiers, scope: "desktop" },
      signal,
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    let failure: unknown;
    const startResults = await Promise.allSettled([
      this.windowStartPromise,
      this.desktopStartPromise,
    ]);
    for (const result of startResults) {
      if (result.status === "rejected") {
        failure ??= result.reason;
      }
    }
    if (this.client.isAvailable()) {
      if (this.windowStarted) {
        try {
          await this.client.callTool("end_session", { session: this.windowPublicSession });
        } catch (error) {
          failure ??= error;
        }
      }
      if (this.desktopStarted) {
        try {
          await this.client.callTool("end_session", { session: this.desktopPublicSession });
        } catch (error) {
          failure ??= error;
        }
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

  private async desktopTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CuaToolResult> {
    await this.ensureStarted("desktop", signal);
    return await this.client.callTool(
      name,
      { ...args, session: this.desktopPublicSession },
      signal,
    );
  }

  private async ensureStarted(scope: "window" | "desktop", signal?: AbortSignal): Promise<void> {
    if (this.disposed) {
      throw driverUnavailable("cua-computer is stopping");
    }
    const isWindow = scope === "window";
    const startedKey = isWindow ? "windowStarted" : "desktopStarted";
    const startPromiseKey = isWindow ? "windowStartPromise" : "desktopStartPromise";
    const current = this[startPromiseKey];
    if (!current) {
      const publicSession = isWindow ? this.windowPublicSession : this.desktopPublicSession;
      const start = this.client
        .callTool("start_session", { session: publicSession, capture_scope: scope }, signal)
        .then((result) => {
          if (result.isError) {
            throw driverProtocolError(result.text || "CUA MCP start_session failed");
          }
          this[startedKey] = true;
        });
      this[startPromiseKey] = start;
      try {
        await start;
      } catch (error) {
        if (this[startPromiseKey] === start) {
          this[startPromiseKey] = undefined;
        }
        throw error;
      }
      return;
    }
    await current;
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
