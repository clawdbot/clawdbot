import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import { z } from "zod";
import { PROTOCOL_VERSION } from "../../src/gateway/protocol/index.ts";
import { formatErrorMessage } from "../../src/infra/errors.ts";
import { rawDataToString } from "../../src/infra/ws.ts";
import { readStringValue } from "../../src/shared/string-coerce.ts";

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
  request<T>(method: string, params?: unknown): Promise<T>;
  events: Array<{ event: string; payload: Record<string, unknown> }>;
  close(): Promise<void>;
};

export type McpClientHandle = {
  client: Client;
  transport: StdioClientTransport;
  rawMessages: unknown[];
};

const GATEWAY_WS_OPEN_TIMEOUT_MS = 45_000;
const GATEWAY_RPC_TIMEOUT_MS = 60_000;
const GATEWAY_REQUEST_TIMEOUT_MS = 45_000;
const GATEWAY_CONNECT_RETRY_WINDOW_MS = 420_000;

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
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
  const ws = new WebSocket(params.url);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("gateway ws open timeout"));
    }, GATEWAY_WS_OPEN_TIMEOUT_MS);
    timeout.unref?.();
    ws.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  const requestedScopes = ["operator.read", "operator.write", "operator.pairing", "operator.admin"];
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];

  ws.on("message", (data) => {
    let frame: unknown;
    try {
      frame = JSON.parse(rawDataToString(data));
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") {
      return;
    }
    const typed = frame as {
      type?: unknown;
      event?: unknown;
      payload?: unknown;
      id?: unknown;
      ok?: unknown;
      result?: unknown;
      error?: { message?: unknown } | null;
    };
    if (typed.type === "event" && typeof typed.event === "string") {
      events.push({
        event: typed.event,
        payload:
          typed.payload && typeof typed.payload === "object"
            ? (typed.payload as Record<string, unknown>)
            : {},
      });
      return;
    }
    if (typed.type !== "res" || typeof typed.id !== "string") {
      return;
    }
    const match = pending.get(typed.id);
    if (!match) {
      return;
    }
    pending.delete(typed.id);
    if (typed.ok === true) {
      match.resolve(typed.payload ?? typed.result);
      return;
    }
    match.reject(
      new Error(
        typed.error && typeof typed.error.message === "string"
          ? typed.error.message
          : "gateway request failed",
      ),
    );
  });

  ws.once("close", (code, reason) => {
    const error = new Error(`gateway closed (${code}): ${rawDataToString(reason)}`);
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
  });

  const connectId = randomUUID();
  ws.send(
    JSON.stringify({
      type: "req",
      id: connectId,
      method: "connect",
      params: {
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
    }),
  );

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(connectId);
      reject(new Error("gateway connect timeout"));
    }, GATEWAY_RPC_TIMEOUT_MS);
    timeout.unref?.();
    pending.set(connectId, {
      resolve: () => {
        clearTimeout(timeout);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
  });

  await new Promise<void>((resolve, reject) => {
    const id = randomUUID();
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("gateway sessions.subscribe timeout"));
    }, GATEWAY_RPC_TIMEOUT_MS);
    timeout.unref?.();
    pending.set(id, {
      resolve: () => {
        clearTimeout(timeout);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    ws.send(
      JSON.stringify({
        type: "req",
        id,
        method: "sessions.subscribe",
        params: {},
      }),
    );
  });

  return {
    request(method, requestParams) {
      const id = randomUUID();
      ws.send(
        JSON.stringify({
          type: "req",
          id,
          method,
          params: requestParams ?? {},
        }),
      );
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`gateway request timeout: ${method}`));
        }, GATEWAY_REQUEST_TIMEOUT_MS);
        timeout.unref?.();
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value as T);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
      });
    },
    events,
    async close() {
      if (ws.readyState === WebSocket.CLOSED) {
        return;
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 2_000);
        timeout.unref?.();
        ws.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
        ws.close();
      });
    },
  };
}

function isRetryableGatewayConnectError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("gateway ws open timeout") ||
    message.includes("gateway connect timeout") ||
    message.includes("gateway closed") ||
    message.includes("econnrefused") ||
    message.includes("socket hang up")
  );
}

export async function connectMcpClient(params: {
  gatewayUrl: string;
  gatewayToken: string;
}): Promise<McpClientHandle> {
  const tokenDir = "/tmp/openclaw-mcp-client";
  const tokenFile = `${tokenDir}/gateway.token`;
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(tokenFile, `${params.gatewayToken}\n`, { encoding: "utf8", mode: 0o600 });
  const transport = new StdioClientTransport({
    command: "node",
    args: [
      "/app/openclaw.mjs",
      "mcp",
      "serve",
      "--url",
      params.gatewayUrl,
      "--token-file",
      tokenFile,
      "--claude-channel-mode",
      "on",
    ],
    cwd: "/app",
    env: {
      ...process.env,
      OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
      OPENCLAW_STATE_DIR: "/tmp/openclaw-mcp-client",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    process.stderr.write(`[openclaw mcp] ${String(chunk)}`);
  });
  const rawMessages: unknown[] = [];
  // The MCP stdio transport here exposes a writable onmessage callback at
  // runtime, not an EventTarget-style addEventListener API.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onmessage = (message) => {
    rawMessages.push(message);
  };

  const client = new Client({ name: "docker-mcp-channels", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport, rawMessages };
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
    if (message.includes("missing scope: operator.pairing")) {
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
