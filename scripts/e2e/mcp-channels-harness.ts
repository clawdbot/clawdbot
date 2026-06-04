// Shared MCP-channel Docker E2E harness helpers.
// The mounted test harness imports packaged dist modules so bridge assertions run
// against the OpenClaw npm tarball installed in the functional image.
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { PROTOCOL_VERSION } from "../../dist/gateway/protocol/index.js";
import { formatErrorMessage } from "../../dist/infra/errors.js";
import { readStringValue } from "../../dist/normalization-core/string-coerce.js";
import { createGatewayWsClient, type GatewayEventFrame } from "../lib/gateway-ws-client.ts";
import { resolveGatewaySuccessPayload } from "./lib/gateway-frame-payload.mjs";
import { readMcpChannelLimits } from "./mcp-channel-limits.ts";
import { createMcpClientTempState, type McpClientTempState } from "./mcp-client-temp-state.ts";
import { connectMcpWithTimeout } from "./mcp-connect-timeout.ts";

export const ClaudeChannelNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.record(z.string(), z.string()),
  }),
});

export const ClaudePermissionNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel/permission"),
  params: z.object({
    request_id: z.string(),
    behavior: z.enum(["allow", "deny"]),
  }),
});

export type ClaudeChannelNotification = z.infer<typeof ClaudeChannelNotificationSchema>["params"];

export type GatewayRpcClient = {
  request<T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  events: Array<{ event: string; payload: Record<string, unknown> }>;
  close(): Promise<void>;
};

export type McpClientHandle = {
  client: Client;
  cleanup(): void;
  transport: StdioClientTransport;
  rawMessages: unknown[];
};

const GATEWAY_WS_OPEN_TIMEOUT_MS = 45_000;
const GATEWAY_RPC_TIMEOUT_MS = 60_000;
const GATEWAY_REQUEST_TIMEOUT_MS = 45_000;
const GATEWAY_CONNECT_RETRY_WINDOW_MS = 420_000;
const MCP_CHANNEL_LIMITS = readMcpChannelLimits();
const MCP_CONNECT_TIMEOUT_MS = MCP_CHANNEL_LIMITS.connectTimeoutMs;
const GATEWAY_EVENT_RETAIN_LIMIT = MCP_CHANNEL_LIMITS.gatewayEventRetainLimit;
const MCP_RAW_MESSAGE_RETAIN_LIMIT = MCP_CHANNEL_LIMITS.rawMessageRetainLimit;

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function pushBounded<T>(items: T[], item: T, limit: number): void {
  items.push(item);
  if (items.length > limit) {
    items.splice(0, items.length - limit);
  }
}

export function extractTextFromGatewayPayload(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const message = payload?.message;
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string" && content.trim().length > 0) {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const first = content[0];
  if (!first || typeof first !== "object") {
    return undefined;
  }
  return readStringValue((first as { text?: unknown }).text);
}

export async function waitFor<T>(
  label: string,
  predicate: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 10_000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value !== undefined) {
      return value;
    }
    await delay(50);
  }
  throw new Error(`timeout waiting for ${label}`);
}

export async function connectGateway(params: {
  url: string;
  token: string;
}): Promise<GatewayRpcClient> {
  const startedAt = Date.now();
  let attempt = 0;
  let lastError: Error | null = null;

  while (Date.now() - startedAt < GATEWAY_CONNECT_RETRY_WINDOW_MS) {
    attempt += 1;
    try {
      return await connectGatewayOnce(params);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isRetryableGatewayConnectError(lastError)) {
        throw lastError;
      }
      await delay(Math.min(500 * attempt, 2_000));
    }
  }

  throw lastError ?? new Error("gateway ws open timeout");
}

async function connectGatewayOnce(params: {
  url: string;
  token: string;
}): Promise<GatewayRpcClient> {
  const requestedScopes = ["operator.read", "operator.write", "operator.pairing", "operator.admin"];
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const gatewayClient = createGatewayWsClient({
    handshakeTimeoutMs: GATEWAY_WS_OPEN_TIMEOUT_MS,
    onEvent(event: GatewayEventFrame) {
      pushBounded(
        events,
        {
          event: event.event,
          payload:
            event.payload && typeof event.payload === "object"
              ? (event.payload as Record<string, unknown>)
              : {},
        },
        GATEWAY_EVENT_RETAIN_LIMIT,
      );
    },
    openTimeoutMs: GATEWAY_WS_OPEN_TIMEOUT_MS,
    openTimeoutMessage: "gateway ws open timeout",
    url: params.url,
  });
  await gatewayClient.waitOpen();

  const sendGatewayRequest = <T = unknown>(
    method: string,
    requestParams: unknown,
    timeoutMs: number,
  ): Promise<T> => {
    return gatewayClient.request(method, requestParams ?? {}, timeoutMs).then((response) => {
      if (response.ok) {
        return resolveGatewaySuccessPayload(response) as T;
      }
      throw new Error(
        response.error && typeof response.error === "object" && "message" in response.error
          ? String(response.error.message)
          : "gateway request failed",
      );
    });
  };

  await sendGatewayRequest(
    "connect",
    {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "openclaw-tui",
        displayName: "docker-mcp-channels",
        version: "1.0.0",
        platform: process.platform,
        mode: "ui",
      },
      role: "operator",
      scopes: requestedScopes,
      caps: [],
      auth: { token: params.token },
    },
    GATEWAY_RPC_TIMEOUT_MS,
  );

  await sendGatewayRequest("sessions.subscribe", {}, GATEWAY_RPC_TIMEOUT_MS);

  return {
    request(method, requestParams, opts) {
      return sendGatewayRequest(
        method,
        requestParams,
        opts?.timeoutMs ?? GATEWAY_REQUEST_TIMEOUT_MS,
      );
    },
    events,
    async close() {
      gatewayClient.close();
    },
  };
}

function isRetryableGatewayConnectError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("gateway ws open timeout") ||
    message.includes("gateway connect timeout") ||
    message.includes("closed before open") ||
    message.includes("gateway closed") ||
    message.includes("gateway websocket closed") ||
    message.includes("econnrefused") ||
    message.includes("socket hang up")
  );
}

export async function connectMcpClient(params: {
  gatewayUrl: string;
  gatewayToken: string;
  tempState?: McpClientTempState;
}): Promise<McpClientHandle> {
  const ownsTempState = !params.tempState;
  const tempState =
    params.tempState ?? createMcpClientTempState({ gatewayToken: params.gatewayToken });
  const transport = new StdioClientTransport({
    command: "node",
    args: [
      "/app/openclaw.mjs",
      "mcp",
      "serve",
      "--url",
      params.gatewayUrl,
      "--token-file",
      tempState.tokenFile,
      "--claude-channel-mode",
      "on",
    ],
    cwd: "/app",
    env: {
      ...process.env,
      OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
      OPENCLAW_STATE_DIR: tempState.stateDir,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    process.stderr.write(`[openclaw mcp] ${String(chunk)}`);
  });
  const rawMessages: unknown[] = [];
  Reflect.set(transport, "onmessage", (message: unknown) => {
    pushBounded(rawMessages, message, MCP_RAW_MESSAGE_RETAIN_LIMIT);
  });

  const client = new Client({ name: "docker-mcp-channels", version: "1.0.0" });
  try {
    await connectMcpWithTimeout(client, transport, MCP_CONNECT_TIMEOUT_MS);
    return {
      client,
      cleanup: ownsTempState ? tempState.cleanup : () => {},
      transport,
      rawMessages,
    };
  } catch (error) {
    await Promise.allSettled([client.close(), transport.close()]);
    if (ownsTempState) {
      tempState.cleanup();
    }
    throw error;
  }
}

export async function maybeApprovePendingBridgePairing(
  gateway: GatewayRpcClient,
): Promise<boolean> {
  let pairingState:
    | {
        pending?: Array<{ requestId?: string; role?: string }>;
      }
    | undefined;
  try {
    pairingState = await gateway.request<{
      pending?: Array<{ requestId?: string; role?: string }>;
    }>("device.pair.list", {});
  } catch (error) {
    const message = formatErrorMessage(error);
    if (
      message.includes("missing scope: operator.pairing") ||
      message.includes("device.pair.list")
    ) {
      return false;
    }
    throw error;
  }
  if (!pairingState) {
    return false;
  }
  const pendingRequest = pairingState.pending?.find((entry) => entry.role === "operator");
  if (!pendingRequest?.requestId) {
    return false;
  }
  await gateway.request("device.pair.approve", { requestId: pendingRequest.requestId });
  return true;
}
