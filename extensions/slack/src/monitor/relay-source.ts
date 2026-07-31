// Slack plugin module implements relay-backed inbound event transport.
import { Buffer } from "node:buffer";
import { isIP } from "node:net";
import {
  computeBackoff,
  sleepWithAbort,
  warn,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import type { SlackSendIdentity } from "../send.js";
import type { SlackMessageEvent } from "../types.js";
import { formatUnknownError, SLACK_SOCKET_RECONNECT_POLICY } from "./reconnect-policy.js";

export type SlackRelaySourceConfig = {
  url: string;
  authToken: string;
  gatewayId: string;
};

export type SlackRelayIdentity = SlackSendIdentity;

const SLACK_RELAY_ROUTE_KINDS = new Set(["user_group", "thread_affinity", "channel_default"]);
export const SLACK_RELAY_MAX_PAYLOAD_BYTES = 1024 * 1024;

type SlackRelayRoute = {
  kind: "user_group" | "thread_affinity" | "channel_default";
  key: string;
};

export type SlackRelayEventAcceptor = (event: {
  deliveryId: string;
  message: SlackMessageEvent;
}) => Promise<void>;

export async function monitorSlackRelaySource(params: {
  config: SlackRelaySourceConfig;
  acceptRelayEvent: SlackRelayEventAcceptor;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  setStatus?: (next: Record<string, unknown>) => void;
  setIdentity?: (identity: SlackRelayIdentity | undefined) => void;
}): Promise<void> {
  let reconnectAttempts = 0;
  while (!params.abortSignal?.aborted) {
    let connection: WebSocket | undefined;
    try {
      connection = await openRelayWebSocket(params.config, params.abortSignal);
      reconnectAttempts = 0;
      params.setStatus?.({
        connected: true,
        lastConnectedAt: Date.now(),
        healthState: "healthy",
        lastError: null,
      });
      params.runtime.log?.(`slack relay mode connected gateway_id:${params.config.gatewayId}`);
      await runRelayWebSocket({
        connection,
        acceptRelayEvent: params.acceptRelayEvent,
        runtime: params.runtime,
        abortSignal: params.abortSignal,
        setStatus: params.setStatus,
        setIdentity: params.setIdentity,
      });
    } catch (err) {
      if (params.abortSignal?.aborted) {
        break;
      }
      reconnectAttempts += 1;
      const delayMs = computeBackoff(SLACK_SOCKET_RECONNECT_POLICY, reconnectAttempts);
      params.setStatus?.({
        connected: false,
        healthState: "disconnected",
        lastDisconnect: { at: Date.now(), error: formatUnknownError(err) },
        lastError: formatUnknownError(err),
      });
      params.runtime.log?.(
        warn(
          `slack relay mode disconnected; reconnecting in ${Math.round(delayMs / 1000)}s ` +
            `(attempt ${reconnectAttempts}) ` +
            `reason="${formatUnknownError(err)}"`,
        ),
      );
      await sleepWithAbort(delayMs, params.abortSignal);
    } finally {
      closeRelayWebSocket(connection);
      params.setIdentity?.(undefined);
    }
  }
}

function openRelayWebSocket(
  config: SlackRelaySourceConfig,
  abortSignal?: AbortSignal,
): Promise<WebSocket> {
  if (abortSignal?.aborted) {
    return Promise.reject(new Error("Slack relay websocket aborted before connect"));
  }
  return new Promise((resolve, reject) => {
    const url = buildRelayWebSocketUrl(config);
    const ws = new WebSocket(url, buildRelayWebSocketOptions(config.authToken));

    const cleanup = () => {
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
      abortSignal?.removeEventListener("abort", onAbort);
    };
    const onOpen = () => {
      ws.pause();
      cleanup();
      resolve(ws);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(formatRelayClose(code, reason)));
    };
    const onAbort = () => {
      cleanup();
      closeRelayWebSocket(ws);
      reject(new Error("Slack relay websocket aborted during connect"));
    };

    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

function runRelayWebSocket(params: {
  connection: WebSocket;
  acceptRelayEvent: SlackRelayEventAcceptor;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  setStatus?: (next: Record<string, unknown>) => void;
  setIdentity?: (identity: SlackRelayIdentity | undefined) => void;
}): Promise<void> {
  const ws = params.connection;
  let pending = Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
      params.abortSignal?.removeEventListener("abort", onAbort);
    };
    const settleResolve = () => {
      cleanup();
      pending.then(resolve, reject);
    };
    const settleReject = (error: Error) => {
      cleanup();
      pending.then(() => reject(error), reject);
    };
    const onMessage = (data: RawData) => {
      pending = pending
        .then(() =>
          handleRelayFrame({
            ws,
            data,
            acceptRelayEvent: params.acceptRelayEvent,
            setStatus: params.setStatus,
            setIdentity: params.setIdentity,
          }),
        )
        .catch((err: unknown) => {
          params.runtime.error?.(`slack relay frame failed: ${formatUnknownError(err)}`);
        });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number, reason: Buffer) => {
      const closeReason = formatRelayClose(code, reason);
      params.setStatus?.({
        connected: false,
        healthState: "disconnected",
        lastDisconnect: { at: Date.now(), error: closeReason },
      });
      settleReject(new Error(closeReason));
    };
    const onAbort = () => {
      closeRelayWebSocket(ws);
      settleResolve();
    };

    ws.on("message", onMessage);
    ws.once("error", onError);
    ws.once("close", onClose);
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
    ws.resume();
  });
}

async function handleRelayFrame(params: {
  ws: WebSocket;
  data: RawData;
  acceptRelayEvent: SlackRelayEventAcceptor;
  setStatus?: (next: Record<string, unknown>) => void;
  setIdentity?: (identity: SlackRelayIdentity | undefined) => void;
}): Promise<void> {
  const frame = parseRelayFrame(params.data);
  const hello = extractRelayHello(frame);
  if (hello) {
    params.setIdentity?.(hello.identity);
    params.setStatus?.({ relayIdentity: hello.identity ?? null });
    return;
  }
  const event = extractRelaySlackMessageEvent(frame);
  if (!event) {
    return;
  }
  const now = Date.now();
  params.setStatus?.({ lastEventAt: now, lastInboundAt: now });
  params.setStatus?.({ relayRoute: event.route });
  // Durable-before-ack: the router redelivers unacked frames, so the ack must
  // gate on the SQLite enqueue. Dispatch runs through the durable drain; the
  // logical message-id tombstone dedupes redeliveries of an already-acked frame.
  await params.acceptRelayEvent({ deliveryId: event.deliveryId, message: event.message });
  sendRelayAck(params.ws, event.deliveryId);
}

export function buildRelayWebSocketOptions(authToken: string): ClientOptions {
  return {
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
    handshakeTimeout: 30_000,
    maxPayload: SLACK_RELAY_MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  };
}

export function buildRelayWebSocketUrl(config: SlackRelaySourceConfig): string {
  const url = new URL(config.url);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Slack relay URL must use http(s) or ws(s): ${config.url}`);
  }
  if (url.protocol === "ws:" && !isLocalRelayHost(url.hostname)) {
    throw new Error(
      `Slack relay URL uses plaintext ws:// for non-local host "${url.host}". ` +
        "Use wss:// for remote relay URLs; ws:// is only allowed for localhost, 127.0.0.1, or [::1].",
    );
  }
  if (!url.pathname || url.pathname === "/") {
    throw new Error(`Slack relay URL must include its websocket path: ${config.url}`);
  }
  url.searchParams.set("gateway_id", config.gatewayId);
  return url.toString();
}

function isLocalRelayHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  const host =
    normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
  if (host === "localhost" || host === "::1") {
    return true;
  }
  return isIP(host) === 4 && host.startsWith("127.");
}

export class SlackRelayMalformedFrameError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SlackRelayMalformedFrameError";
  }
}

export function parseRelayFrame(data: RawData): unknown {
  const text = rawDataToString(data);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new SlackRelayMalformedFrameError("Slack relay received malformed JSON frame", { cause });
  }
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function extractRelaySlackMessageEvent(
  frame: unknown,
): { deliveryId: string; message: SlackMessageEvent; route: SlackRelayRoute } | undefined {
  const record = asRecord(frame);
  if (!record || record.type !== "slack_event") {
    return undefined;
  }
  const deliveryId = stringValue(record.delivery_id);
  const routeRecord = asRecord(record.route);
  const routeKind = stringValue(routeRecord?.kind);
  const routeKey = stringValue(routeRecord?.key);
  const payload = asRecord(record.payload);
  const event = asRecord(payload?.event);
  if (event?.type !== "message" || typeof event.channel !== "string") {
    return undefined;
  }
  if (!deliveryId || !routeKind || !SLACK_RELAY_ROUTE_KINDS.has(routeKind) || !routeKey) {
    return undefined;
  }
  return {
    deliveryId,
    message: event as SlackMessageEvent,
    route: {
      kind: routeKind as SlackRelayRoute["kind"],
      key: routeKey,
    },
  };
}

function extractRelayHello(
  frame: unknown,
): { identity: SlackRelayIdentity | undefined } | undefined {
  const record = asRecord(frame);
  if (!record || record.type !== "hello") {
    return undefined;
  }
  return {
    identity: extractRelayIdentity(record),
  };
}

function extractRelayIdentity(record: Record<string, unknown>): SlackRelayIdentity | undefined {
  const identityRecord = asRecord(record.slack_identity) ?? asRecord(record.slackIdentity);
  if (!identityRecord) {
    return undefined;
  }
  const username = normalizeOptionalString(identityRecord.username);
  const iconUrl =
    normalizeOptionalString(identityRecord.icon_url) ??
    normalizeOptionalString(identityRecord.iconUrl);
  const iconEmoji =
    normalizeOptionalString(identityRecord.icon_emoji) ??
    normalizeOptionalString(identityRecord.iconEmoji);
  if (!username && !iconUrl && !iconEmoji) {
    return undefined;
  }
  return {
    ...(username ? { username } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    ...(iconEmoji ? { iconEmoji } : {}),
  };
}

function sendRelayAck(ws: WebSocket, deliveryId: string): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(
    JSON.stringify({
      type: "ack",
      delivery_id: deliveryId,
    }),
  );
}

function closeRelayWebSocket(ws: WebSocket | undefined): void {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    return;
  }
  ws.close();
}

function formatRelayClose(code: number, reason: Buffer): string {
  const text = reason.toString("utf8");
  return text
    ? `Slack relay websocket closed (${code} ${text})`
    : `Slack relay websocket closed (${code})`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
