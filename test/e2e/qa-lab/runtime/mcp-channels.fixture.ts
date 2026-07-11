// Shared MCP-channel QA/Docker E2E fixture helpers.
// The mounted test harness imports packaged dist modules so bridge assertions run
// against the OpenClaw npm tarball installed in the functional image.
import crypto from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
const protocolModulePath = "../../../../dist/gateway/protocol/index.js" as string;
const errorsModulePath = "../../../../dist/infra/errors.js" as string;
const stringCoerceModulePath = "../../../../dist/normalization-core/string-coerce.js" as string;
const [{ PROTOCOL_VERSION }, { formatErrorMessage }, { readStringValue }] = await Promise.all([
  import(protocolModulePath) as Promise<
    typeof import("../../../../packages/gateway-protocol/src/index.js")
  >,
  import(errorsModulePath) as Promise<typeof import("../../../../src/infra/errors.js")>,
  import(stringCoerceModulePath) as Promise<
    typeof import("../../../../packages/normalization-core/src/string-coerce.js")
  >,
]);
import { resolveGatewaySuccessPayload } from "../../../../scripts/e2e/lib/gateway-frame-payload.mjs";
import { readMcpChannelLimits } from "../../../../scripts/e2e/mcp-channel-limits.ts";
import {
  createGatewayWsClient,
  type GatewayEventFrame,
} from "../../../../scripts/lib/gateway-ws-client.ts";
import {
  connectMcpWithTimeout,
  createMcpClientTempState,
  type McpClientTempState,
} from "./mcp-client-temp-state.fixture.ts";

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
  auth: GatewayConnectAuth;
  request<T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  events: Array<{ event: string; payload: Record<string, unknown> }>;
  close(): Promise<void>;
};

export type GatewayConnectAuth = {
  role: string;
  scopes: string[];
  deviceToken?: string;
};

type GatewayClientInfo = {
  id: string;
  displayName: string;
  version: string;
  platform: string;
  mode: string;
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
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const DEFAULT_GATEWAY_CLIENT: GatewayClientInfo = {
  id: "openclaw-tui",
  displayName: "docker-mcp-channels",
  version: "1.0.0",
  platform: process.platform,
  mode: "ui",
};

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
  scopes?: readonly string[];
  client?: GatewayClientInfo;
  bindFreshDevice?: boolean;
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
  scopes?: readonly string[];
  client?: GatewayClientInfo;
  bindFreshDevice?: boolean;
}): Promise<GatewayRpcClient> {
  const requestedScopes = params.scopes ?? [
    "operator.read",
    "operator.write",
    "operator.pairing",
    "operator.admin",
  ];
  const client = params.client ?? DEFAULT_GATEWAY_CLIENT;
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

  const device = params.bindFreshDevice
    ? await createSignedOperatorDevice({
        events,
        token: params.token,
        scopes: requestedScopes,
        client,
      })
    : undefined;

  const connectPayload = await sendGatewayRequest(
    "connect",
    {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client,
      role: "operator",
      scopes: requestedScopes,
      caps: [],
      auth: { token: params.token },
      ...(device ? { device } : {}),
    },
    GATEWAY_RPC_TIMEOUT_MS,
  );
  const auth = readGatewayConnectAuth(connectPayload);

  await sendGatewayRequest("sessions.subscribe", {}, GATEWAY_RPC_TIMEOUT_MS);

  return {
    auth,
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

function readGatewayConnectAuth(payload: unknown): GatewayConnectAuth {
  const auth = payload && typeof payload === "object" ? (payload as { auth?: unknown }).auth : null;
  if (!auth || typeof auth !== "object") {
    throw new Error(`gateway hello-ok missing auth metadata: ${JSON.stringify(payload)}`);
  }
  const record = auth as { role?: unknown; scopes?: unknown; deviceToken?: unknown };
  if (typeof record.role !== "string" || !Array.isArray(record.scopes)) {
    throw new Error(`gateway hello-ok auth metadata has invalid shape: ${JSON.stringify(auth)}`);
  }
  return {
    role: record.role,
    scopes: record.scopes.filter((scope): scope is string => typeof scope === "string"),
    ...(typeof record.deviceToken === "string" ? { deviceToken: record.deviceToken } : {}),
  };
}

export function assertGatewayScopes(
  gateway: GatewayRpcClient,
  expected: { include?: readonly string[]; exclude?: readonly string[]; label: string },
) {
  const scopes = new Set(gateway.auth.scopes);
  const missing = (expected.include ?? []).filter((scope) => !scopes.has(scope));
  const forbidden = (expected.exclude ?? []).filter((scope) => scopes.has(scope));
  assert(
    missing.length === 0 && forbidden.length === 0,
    `${expected.label} granted unexpected gateway scopes: ${JSON.stringify({
      granted: gateway.auth.scopes,
      missing,
      forbidden,
    })}`,
  );
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function normalizeDeviceMetadataForAuth(value?: string | null): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

function derivePublicKeyRaw(publicKey: crypto.KeyObject): Buffer {
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function createEphemeralDeviceIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyRaw = derivePublicKeyRaw(publicKey);
  return {
    deviceId: crypto.createHash("sha256").update(publicKeyRaw).digest("hex"),
    privateKey,
    publicKey: base64UrlEncode(publicKeyRaw),
  };
}

// The Docker functional image mounts test files beside the packaged app, not
// source packages. Keep the client-side v3 signing payload local so the bridge
// runtime under test still comes from the package tarball.
function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
  platform?: string | null;
  deviceFamily?: string | null;
}): string {
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
    normalizeDeviceMetadataForAuth(params.platform),
    normalizeDeviceMetadataForAuth(params.deviceFamily),
  ].join("|");
}

function signDevicePayload(privateKey: crypto.KeyObject, payload: string): string {
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), privateKey));
}

async function createSignedOperatorDevice(params: {
  events: Array<{ event: string; payload: Record<string, unknown> }>;
  token: string;
  scopes: readonly string[];
  client: GatewayClientInfo;
}) {
  const nonce = await waitFor(
    "gateway connect challenge nonce",
    () => {
      const challenge = params.events.find((entry) => entry.event === "connect.challenge");
      const value = challenge?.payload.nonce;
      return typeof value === "string" && value.length > 0 ? value : undefined;
    },
    GATEWAY_WS_OPEN_TIMEOUT_MS,
  );
  const identity = createEphemeralDeviceIdentity();
  const signedAtMs = Date.now();
  const payload = buildDeviceAuthPayloadV3({
    deviceId: identity.deviceId,
    clientId: params.client.id,
    clientMode: params.client.mode,
    role: "operator",
    scopes: [...params.scopes],
    signedAtMs,
    token: params.token,
    nonce,
    platform: params.client.platform,
  });
  return {
    id: identity.deviceId,
    publicKey: identity.publicKey,
    signature: signDevicePayload(identity.privateKey, payload),
    signedAt: signedAtMs,
    nonce,
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
