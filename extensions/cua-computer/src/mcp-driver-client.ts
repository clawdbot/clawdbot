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
const MAX_PENDING_REQUESTS = 64;
const MAX_MCP_LINE_BYTES = 256 * 1024 * 1024;
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

function createClient(binaryPath: string, socketPath: string, env: NodeJS.ProcessEnv) {
  const proxyEnvironment = { ...env };
  for (const key of Object.keys(proxyEnvironment)) {
    if (key.startsWith("CUA_DRIVER_") || key === "CUA_TELEMETRY_ENABLED") {
      delete proxyEnvironment[key];
    }
  }
  // The normal Windows/Linux SDK route never loads the MCP runtime graph.
  return import("openclaw/plugin-sdk/agent-harness-runtime")
    .then(({ mcpStdioRuntime }) => mcpStdioRuntime.load())
    .then(({ createMcpStdioClient }) =>
      createMcpStdioClient({
        command: binaryPath,
        args: ["mcp", "--embedded", "--socket", socketPath],
        env: {
          ...proxyEnvironment,
          CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
          CUA_DRIVER_RS_UPDATE_CHECK: "false",
        },
        clientInfo: { name: "openclaw-cua-computer", version: "1" },
        protocolVersion: MCP_PROTOCOL_VERSION,
        startupTimeoutMs: MCP_STARTUP_TIMEOUT_MS,
        maxPendingRequests: MAX_PENDING_REQUESTS,
        maxFrameBytes: MAX_MCP_LINE_BYTES,
        errors: {
          unavailable: (message, cause) => driverUnavailable(`CUA MCP ${message}`, cause),
          protocol: (message, cause) => driverProtocolError(`CUA MCP ${message}`, cause),
        },
      }),
    );
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

  private resolved?: Awaited<ReturnType<typeof createClient>>;

  constructor(private readonly client: ReturnType<typeof createClient>) {
    void client
      .then((resolved) => {
        this.resolved = resolved;
      })
      .catch(() => {});
  }

  isAvailable(): boolean {
    return !this.disposed && this.resolved?.isAvailable() === true;
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
    try {
      const client = await this.client;
      if (client.isAvailable() && this.started) {
        try {
          await this.tool("end_session", {});
        } catch (error) {
          failure ??= error;
        }
      }
      await client.stop();
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
    return await this.tool(name, args, signal);
  }

  private async tool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CuaToolResult> {
    const client = await this.client;
    return normalizeMcpToolResult(
      name,
      await client.request(
        "tools/call",
        {
          name,
          arguments: { ...args, session: this.publicSession },
        },
        { timeoutMs: MCP_REQUEST_TIMEOUT_MS, signal },
      ),
    );
  }

  private async ensureStarted(signal?: AbortSignal): Promise<void> {
    if (this.disposed) {
      throw driverUnavailable("cua-computer is stopping");
    }
    if (!this.startPromise) {
      const start = this.tool("start_session", {}, signal).then((result) => {
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
    createClient(options.binaryPath, options.socketPath, options.env ?? process.env),
  );
}
