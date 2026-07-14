/**
 * Signal client for bbernhard/signal-cli-rest-api container.
 * Uses WebSocket for receiving messages and REST API for sending.
 *
 * This is a separate implementation from client.ts (native signal-cli)
 * to keep the two modes cleanly isolated.
 */

import nodePath from "node:path";
import { resolveFetch } from "openclaw/plugin-sdk/fetch-runtime";
import { detectMime, parseMediaContentLength } from "openclaw/plugin-sdk/media-runtime";
import {
  parseStrictNonNegativeInteger,
  resolveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import {
  readResponseTextPrefix,
  readResponseWithLimit,
} from "openclaw/plugin-sdk/response-limit-runtime";
import { readRegularFile } from "openclaw/plugin-sdk/security-runtime";
import WebSocket from "ws";

type ContainerRpcOptions = {
  baseUrl: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxAttachmentBytes?: number;
};

type ContainerWebSocketMessage = {
  envelope?: {
    syncMessage?: unknown;
    dataMessage?: {
      message?: string;
      groupInfo?: { groupId?: string; groupName?: string };
      attachments?: Array<{
        id?: string;
        contentType?: string;
        filename?: string;
        size?: number;
      }>;
      quote?: { text?: string };
      reaction?: unknown;
    };
    editMessage?: { dataMessage?: unknown };
    reactionMessage?: unknown;
    sourceNumber?: string;
    sourceUuid?: string;
    sourceName?: string;
    timestamp?: number;
  };
  exception?: { message?: string };
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTACHMENT_RESPONSE_MAX_BYTES = 1_048_576;
const SIGNAL_REST_ERROR_RESPONSE_MAX_BYTES = 16 * 1024;
const SIGNAL_REST_SUCCESS_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
// Receive envelopes contain JSON metadata; attachment bytes are fetched separately.
// Keep the ws pre-buffer limit narrow so a container cannot force 100 MiB frames.
const SIGNAL_CONTAINER_WS_MAX_PAYLOAD_BYTES = 1024 * 1024;
// Outbound file paths are converted to base64 before posting to the container. Cap
// reads to the same default the native signal send path uses (8 MiB) so a path to a
// huge or symlinked file cannot OOM the gateway before encoding.
const DEFAULT_SIGNAL_CONTAINER_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const CONTAINER_TEXT_STYLE_MARKERS: Record<string, string> = {
  BOLD: "**",
  ITALIC: "*",
  STRIKETHROUGH: "~",
  MONOSPACE: "`",
  SPOILER: "||",
};

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("Signal base URL is required");
  }
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Signal base URL unsupported protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Signal base URL must not include credentials");
  }
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const fetchImpl = resolveFetch();
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }
  const safeTimeoutMs = resolveTimerTimeoutMs(timeoutMs, DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), safeTimeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeMaxResponseBytes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_ATTACHMENT_RESPONSE_MAX_BYTES;
  }
  return Math.floor(value);
}

function readContentLength(res: Response): number | undefined {
  return parseMediaContentLength(res.headers?.get("content-length") ?? null) ?? undefined;
}

function signalRestIdleTimeoutError({ chunkTimeoutMs }: { chunkTimeoutMs: number }): Error {
  return new Error(`Signal REST response body stalled after ${chunkTimeoutMs}ms`);
}

function signalAttachmentIdleTimeoutError({ chunkTimeoutMs }: { chunkTimeoutMs: number }): Error {
  return new Error(`Signal REST attachment response body stalled after ${chunkTimeoutMs}ms`);
}

async function readSignalRestText(res: Response, bodyIdleTimeoutMs: number): Promise<string> {
  const bytes = await readResponseWithLimit(res, SIGNAL_REST_SUCCESS_RESPONSE_MAX_BYTES, {
    chunkTimeoutMs: bodyIdleTimeoutMs,
    onIdleTimeout: signalRestIdleTimeoutError,
    onOverflow: ({ maxBytes }) => new Error(`Signal REST: text response exceeds ${maxBytes} bytes`),
  });
  return new TextDecoder().decode(bytes);
}

async function readSignalRestErrorText(res: Response, bodyIdleTimeoutMs: number): Promise<string> {
  return (
    await readResponseTextPrefix(res, SIGNAL_REST_ERROR_RESPONSE_MAX_BYTES, {
      chunkTimeoutMs: bodyIdleTimeoutMs,
      onIdleTimeout: signalRestIdleTimeoutError,
    })
  ).text;
}

async function readCappedResponseBuffer(
  res: Response,
  maxResponseBytes: number,
  bodyIdleTimeoutMs: number,
): Promise<Buffer> {
  const contentLength = readContentLength(res);
  if (contentLength !== undefined && contentLength > maxResponseBytes) {
    throw new Error("Signal REST attachment exceeded size limit");
  }
  return await readResponseWithLimit(res, maxResponseBytes, {
    chunkTimeoutMs: bodyIdleTimeoutMs,
    onIdleTimeout: signalAttachmentIdleTimeoutError,
    onOverflow: () => new Error("Signal REST attachment exceeded size limit"),
  });
}

async function releaseUnreadResponseBody(res: Response | undefined): Promise<void> {
  if (res?.bodyUsed !== true) {
    await res?.body?.cancel().catch(() => undefined);
  }
}

/**
 * Check if bbernhard container REST API is available.
 */
export async function containerCheck(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  account?: string,
): Promise<{ ok: boolean; status?: number | null; error?: string | null }> {
  const normalized = normalizeBaseUrl(baseUrl);
  let res: Response | undefined;
  try {
    res = await fetchWithTimeout(`${normalized}/v1/about`, { method: "GET" }, timeoutMs);
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const receiveAccount = account?.trim();
    if (receiveAccount) {
      return await containerReceiveCheck(normalized, receiveAccount, timeoutMs);
    }
    return { ok: true, status: res.status, error: null };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await releaseUnreadResponseBody(res);
  }
}

function containerReceiveCheck(
  normalizedBaseUrl: string,
  account: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status?: number | null; error?: string | null }> {
  const wsUrl = `${normalizedBaseUrl.replace(/^http/, "ws")}/v1/receive/${encodeURIComponent(account)}`;
  return new Promise((resolve) => {
    const safeTimeoutMs = resolveTimerTimeoutMs(timeoutMs, DEFAULT_TIMEOUT_MS);
    let settled = false;
    let ws: WebSocket | undefined;
    const timer = setTimeout(() => {
      settle({ ok: false, status: null, error: "Signal container receive WebSocket timed out" });
      ws?.terminate();
    }, safeTimeoutMs);
    timer.unref?.();
    const settle = (result: { ok: boolean; status?: number | null; error?: string | null }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      ws = new WebSocket(wsUrl, { maxPayload: SIGNAL_CONTAINER_WS_MAX_PAYLOAD_BYTES });
    } catch (err) {
      settle({
        ok: false,
        status: null,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    ws.once("open", () => {
      settle({ ok: true, status: 101, error: null });
      ws?.close();
    });
    ws.once("unexpected-response", (_request, response) => {
      settle({
        ok: false,
        status: response.statusCode ?? null,
        error: `Signal container receive endpoint did not upgrade to WebSocket (HTTP ${
          response.statusCode ?? "unknown"
        })`,
      });
      ws?.terminate();
    });
    ws.once("error", (err) => {
      settle({
        ok: false,
        status: null,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    ws.once("close", (code, reason) => {
      const reasonText = reason.length > 0 ? `: ${reason.toString("utf8")}` : "";
      settle({
        ok: false,
        status: null,
        error: `Signal container receive WebSocket closed before open (${code}${reasonText})`,
      });
    });
  });
}

/**
 * Make a REST API request to bbernhard container.
 */
export async function containerRestRequest<T = unknown>(
  endpoint: string,
  opts: ContainerRpcOptions,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown,
): Promise<T> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const url = `${baseUrl}${endpoint}`;

  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };

  if (body) {
    init.body = JSON.stringify(body);
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bodyIdleTimeoutMs = resolveTimerTimeoutMs(timeoutMs, DEFAULT_TIMEOUT_MS);
  const res = await fetchWithTimeout(url, init, timeoutMs);

  if (res.status === 204) {
    return undefined as T;
  }

  if (!res.ok) {
    // Bound the error body: signal-cli-rest-api is an untrusted external container,
    // and a hostile/buggy response must not let an error path buffer an unbounded body.
    const errorText = await readSignalRestErrorText(res, bodyIdleTimeoutMs).catch(() => "");
    throw new Error(`Signal REST ${res.status}: ${errorText || res.statusText}`);
  }

  // Bound the success body under the shared 16 MiB provider cap before JSON.parse so a
  // malicious/runaway container response cannot OOM the runtime (send/typing/version all
  // funnel through here). Reuse the same bounded reader family as the attachment path.
  const text = await readSignalRestText(res, bodyIdleTimeoutMs);
  if (!text) {
    return undefined as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Signal REST returned malformed JSON");
  }
}

/**
 * Fetch attachment binary from bbernhard container.
 */
export async function containerFetchAttachment(
  attachmentId: string,
  opts: ContainerRpcOptions,
): Promise<Buffer | null> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const url = `${baseUrl}/v1/attachments/${encodeURIComponent(attachmentId)}`;
  let res: Response | undefined;

  try {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const bodyIdleTimeoutMs = resolveTimerTimeoutMs(timeoutMs, DEFAULT_TIMEOUT_MS);
    res = await fetchWithTimeout(url, { method: "GET" }, timeoutMs);

    if (!res.ok) {
      return null;
    }

    return await readCappedResponseBuffer(
      res,
      normalizeMaxResponseBytes(opts.maxResponseBytes),
      bodyIdleTimeoutMs,
    );
  } finally {
    await releaseUnreadResponseBody(res);
  }
}

/**
 * Stream messages using WebSocket from bbernhard container.
 * The Promise resolves when the connection closes (for any reason).
 * The caller (runSignalLoopAdapter) is responsible for reconnection.
 */
export async function streamContainerEvents(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  onEvent: (event: ContainerWebSocketMessage) => void;
  logger?: { log?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<void> {
  const normalized = normalizeBaseUrl(params.baseUrl);
  const wsUrl = `${normalized.replace(/^http/, "ws")}/v1/receive/${encodeURIComponent(params.account ?? "")}`;
  const redactedWsUrl = `${normalized.replace(/^http/, "ws")}/v1/receive/<redacted>`;
  const log = params.logger?.log ?? (() => {});
  const logError = params.logger?.error ?? (() => {});

  log(`[signal-ws] connecting to ${redactedWsUrl}`);

  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    let resolved = false;
    let abortHandler: (() => void) | undefined;

    const cleanup = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      if (abortHandler) {
        params.abortSignal?.removeEventListener("abort", abortHandler);
        abortHandler = undefined;
      }
    };

    try {
      ws = new WebSocket(wsUrl, { maxPayload: SIGNAL_CONTAINER_WS_MAX_PAYLOAD_BYTES });
    } catch (err) {
      logError(
        `[signal-ws] failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}`,
      );
      reject(toLintErrorObject(err, "Non-Error rejection"));
      return;
    }

    ws.on("open", () => {
      log("[signal-ws] connected");
    });

    ws.on("message", (data: Buffer) => {
      try {
        const text = data.toString();
        const envelope = JSON.parse(text) as ContainerWebSocketMessage;
        if (envelope) {
          params.onEvent(envelope);
        }
      } catch (err) {
        logError(`[signal-ws] parse error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    ws.on("error", (err) => {
      logError(`[signal-ws] error: ${err instanceof Error ? err.message : String(err)}`);
      // Don't resolve here - the close event will fire next
    });

    ws.on("close", (code, reason) => {
      const reasonStr = reason?.toString() || "no reason";
      log(`[signal-ws] closed (code=${code}, reason=${reasonStr})`);
      cleanup();
      resolve(); // Let the outer loop handle reconnection
    });

    ws.on("ping", () => {
      log("[signal-ws] ping received");
    });

    ws.on("pong", () => {
      log("[signal-ws] pong received");
    });

    if (params.abortSignal) {
      abortHandler = () => {
        log("[signal-ws] aborted, closing connection");
        cleanup();
        ws.close();
        resolve();
      };
      params.abortSignal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

/**
 * Convert local file paths to base64 data URIs for the container REST API.
 * The bbernhard container /v2/send only accepts `base64_attachments` (not file paths).
 */
async function filesToBase64DataUris(
  filePaths: string[],
  maxAttachmentBytes: number,
): Promise<string[]> {
  const results: string[] = [];
  let remainingBytes = maxAttachmentBytes;
  for (const filePath of filePaths) {
    // One send owns one raw-byte budget. A per-file cap would let attachment
    // count multiply the memory consumed before the container request starts.
    const { buffer } = await readRegularFile({
      filePath,
      maxBytes: remainingBytes,
    });
    remainingBytes -= buffer.byteLength;
    const mime = (await detectMime({ buffer, filePath })) ?? "application/octet-stream";
    const filename = nodePath.basename(filePath);
    const b64 = buffer.toString("base64");
    results.push(`data:${mime};filename=${filename};base64,${b64}`);
  }
  return results;
}

function escapeContainerStyledText(text: string): string {
  return text.replace(/[*~`|]/g, (char) => `\\${char}`);
}

function renderContainerStyledText(
  text: string,
  styles: Array<{ start: number; length: number; style: string }>,
): string {
  const spans = styles
    .map((style) => {
      const marker = CONTAINER_TEXT_STYLE_MARKERS[style.style];
      if (!marker) {
        return null;
      }
      const start = Math.max(0, Math.min(style.start, text.length));
      const end = Math.max(start, Math.min(style.start + style.length, text.length));
      if (end <= start) {
        return null;
      }
      return { start, end, marker };
    })
    .filter((span): span is { start: number; end: number; marker: string } => span !== null);

  if (spans.length === 0) {
    return text;
  }

  const positions = [
    ...new Set([0, text.length, ...spans.flatMap((span) => [span.start, span.end])]),
  ].toSorted((a, b) => a - b);
  let rendered = "";
  for (const [index, pos] of positions.entries()) {
    for (const span of spans
      .filter((candidate) => candidate.end === pos)
      .toSorted((a, b) => b.start - a.start)) {
      rendered += span.marker;
    }
    for (const span of spans
      .filter((candidate) => candidate.start === pos)
      .toSorted((a, b) => b.end - a.end)) {
      rendered += span.marker;
    }
    const next = positions[index + 1];
    if (next !== undefined && next > pos) {
      rendered += escapeContainerStyledText(text.slice(pos, next));
    }
  }
  return rendered;
}

function parseContainerSendTimestamp(raw: unknown): number | undefined {
  if (raw == null) {
    return undefined;
  }
  const timestamp = parseStrictNonNegativeInteger(raw);
  if (timestamp === undefined) {
    throw new Error("Signal REST send returned invalid timestamp");
  }
  return timestamp;
}

function normalizeContainerQuoteTimestamp(raw: unknown): number | undefined {
  return parseStrictNonNegativeInteger(raw) ?? undefined;
}

function normalizeContainerQuoteText(raw: unknown): string | undefined {
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Send message via bbernhard container REST API.
 */
export async function containerSendMessage(params: {
  baseUrl: string;
  account: string;
  recipients: string[];
  message: string;
  textStyles?: Array<{ start: number; length: number; style: string }>;
  attachments?: string[];
  maxAttachmentBytes?: number;
  quoteTimestamp?: number;
  quoteAuthor?: string;
  quoteMessage?: string;
  timeoutMs?: number;
}): Promise<{ timestamp?: number }> {
  const payload: Record<string, unknown> = {
    message: params.message,
    number: params.account,
    recipients: params.recipients,
  };

  if (params.textStyles && params.textStyles.length > 0) {
    payload.message = renderContainerStyledText(params.message, params.textStyles);
    payload["text_mode"] = "styled";
  }

  if (params.attachments && params.attachments.length > 0) {
    // Container API only accepts base64-encoded attachments, not file paths.
    const configuredMaxBytes = params.maxAttachmentBytes;
    const maxAttachmentBytes =
      typeof configuredMaxBytes === "number" &&
      Number.isFinite(configuredMaxBytes) &&
      configuredMaxBytes >= 0
        ? Math.floor(configuredMaxBytes)
        : DEFAULT_SIGNAL_CONTAINER_MAX_ATTACHMENT_BYTES;
    payload.base64_attachments = await filesToBase64DataUris(
      params.attachments,
      maxAttachmentBytes,
    );
  }
  if (params.quoteTimestamp !== undefined && params.quoteAuthor) {
    payload.quote_timestamp = params.quoteTimestamp;
    payload.quote_author = params.quoteAuthor;
    payload.quote_message = params.quoteMessage ?? "";
  }

  const result = await containerRestRequest<{ timestamp?: unknown }>(
    "/v2/send",
    { baseUrl: params.baseUrl, timeoutMs: params.timeoutMs },
    "POST",
    payload,
  );

  const timestamp = parseContainerSendTimestamp(result?.timestamp);
  return timestamp === undefined ? {} : { timestamp };
}

/**
 * Send typing indicator via bbernhard container REST API.
 */
export async function containerSendTyping(params: {
  baseUrl: string;
  account: string;
  recipient: string;
  stop?: boolean;
  timeoutMs?: number;
}): Promise<boolean> {
  const method = params.stop ? "DELETE" : "PUT";
  await containerRestRequest(
    `/v1/typing-indicator/${encodeURIComponent(params.account)}`,
    { baseUrl: params.baseUrl, timeoutMs: params.timeoutMs },
    method,
    { recipient: params.recipient },
  );
  return true;
}

/**
 * Send read receipt via bbernhard container REST API.
 */
export async function containerSendReceipt(params: {
  baseUrl: string;
  account: string;
  recipient: string;
  timestamp: number;
  type?: "read" | "viewed";
  timeoutMs?: number;
}): Promise<boolean> {
  await containerRestRequest(
    `/v1/receipts/${encodeURIComponent(params.account)}`,
    { baseUrl: params.baseUrl, timeoutMs: params.timeoutMs },
    "POST",
    {
      recipient: params.recipient,
      timestamp: params.timestamp,
      receipt_type: params.type ?? "read",
    },
  );
  return true;
}

/**
 * Send a reaction to a message via bbernhard container REST API.
 */
export async function containerSendReaction(params: {
  baseUrl: string;
  account: string;
  recipient: string;
  emoji: string;
  targetAuthor: string;
  targetTimestamp: number;
  groupId?: string;
  timeoutMs?: number;
}): Promise<{ timestamp?: number }> {
  const payload: Record<string, unknown> = {
    recipient: params.recipient,
    reaction: params.emoji,
    target_author: params.targetAuthor,
    timestamp: params.targetTimestamp,
  };

  if (params.groupId) {
    payload.group_id = params.groupId;
  }

  const result = await containerRestRequest<{ timestamp?: number }>(
    `/v1/reactions/${encodeURIComponent(params.account)}`,
    { baseUrl: params.baseUrl, timeoutMs: params.timeoutMs },
    "POST",
    payload,
  );

  return result ?? {};
}

/**
 * Remove a reaction from a message via bbernhard container REST API.
 */
export async function containerRemoveReaction(params: {
  baseUrl: string;
  account: string;
  recipient: string;
  emoji: string;
  targetAuthor: string;
  targetTimestamp: number;
  groupId?: string;
  timeoutMs?: number;
}): Promise<{ timestamp?: number }> {
  const payload: Record<string, unknown> = {
    recipient: params.recipient,
    reaction: params.emoji,
    target_author: params.targetAuthor,
    timestamp: params.targetTimestamp,
  };

  if (params.groupId) {
    payload.group_id = params.groupId;
  }

  const result = await containerRestRequest<{ timestamp?: number }>(
    `/v1/reactions/${encodeURIComponent(params.account)}`,
    { baseUrl: params.baseUrl, timeoutMs: params.timeoutMs },
    "DELETE",
    payload,
  );

  return result ?? {};
}

/**
 * Strip the "uuid:" prefix that native signal-cli accepts but the container API rejects.
 */
function stripUuidPrefix(id: string): string {
  return id.startsWith("uuid:") ? id.slice(5) : id;
}

/**
 * Convert a group internal_id to the container-expected format.
 * The bbernhard container expects groups as "group.{base64(internal_id)}".
 */
function formatGroupIdForContainer(groupId: string): string {
  if (groupId.startsWith("group.")) {
    return groupId;
  }
  return `group.${Buffer.from(groupId).toString("base64")}`;
}

/**
 * Drop-in replacement for native signalRpcRequest that translates
 * JSON-RPC method + params into the equivalent container REST API calls.
 * This keeps all container protocol details (uuid: stripping, group ID
 * formatting, base64 attachments, text-style conversion) isolated here.
 */
export async function containerRpcRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: ContainerRpcOptions,
): Promise<T> {
  const p = params ?? {};
  switch (method) {
    case "send": {
      const recipients = ((p.recipient as string[] | undefined) ?? []).map(stripUuidPrefix);
      const usernames = ((p.username as string[] | undefined) ?? []).map(stripUuidPrefix);
      const groupId = p.groupId as string | undefined;
      const formattedGroupId = groupId ? formatGroupIdForContainer(groupId) : undefined;
      const finalRecipients =
        recipients.length > 0
          ? recipients
          : usernames.length > 0
            ? usernames
            : formattedGroupId
              ? [formattedGroupId]
              : [];

      const textStylesRaw = p["text-style"] as string[] | undefined;
      const textStyles = textStylesRaw?.flatMap((s) => {
        const [start, length, style] = s.split(":");
        if (start === undefined || length === undefined || style === undefined) {
          return [];
        }
        return [{ start: Number(start), length: Number(length), style }];
      });

      const quoteTimestamp = normalizeContainerQuoteTimestamp(
        p.quoteTimestamp ?? p["quote-timestamp"],
      );
      const quoteAuthor = normalizeContainerQuoteText(p.quoteAuthor ?? p["quote-author"]);
      const result = await containerSendMessage({
        baseUrl: opts.baseUrl,
        account: (p.account as string) ?? "",
        recipients: finalRecipients,
        message: (p.message as string) ?? "",
        textStyles,
        attachments: p.attachments as string[] | undefined,
        maxAttachmentBytes: opts.maxAttachmentBytes,
        quoteTimestamp,
        quoteAuthor: quoteAuthor ? stripUuidPrefix(quoteAuthor) : undefined,
        quoteMessage: normalizeContainerQuoteText(p.quoteMessage ?? p["quote-message"]),
        timeoutMs: opts.timeoutMs,
      });
      return result as T;
    }

    case "sendTyping": {
      const recipient = stripUuidPrefix(
        (p.recipient as string[] | undefined)?.[0] ??
          ((p.groupId as string | undefined) ? formatGroupIdForContainer(p.groupId as string) : ""),
      );
      await containerSendTyping({
        baseUrl: opts.baseUrl,
        account: (p.account as string) ?? "",
        recipient,
        stop: p.stop as boolean | undefined,
        timeoutMs: opts.timeoutMs,
      });
      return undefined as T;
    }

    case "sendReceipt": {
      const recipient = stripUuidPrefix((p.recipient as string[] | undefined)?.[0] ?? "");
      await containerSendReceipt({
        baseUrl: opts.baseUrl,
        account: (p.account as string) ?? "",
        recipient,
        timestamp: p.targetTimestamp as number,
        type: p.type as "read" | "viewed" | undefined,
        timeoutMs: opts.timeoutMs,
      });
      return undefined as T;
    }

    case "sendReaction": {
      const recipient = stripUuidPrefix((p.recipients as string[] | undefined)?.[0] ?? "");
      const groupId = (p.groupIds as string[] | undefined)?.[0] ?? undefined;
      const formattedGroupId = groupId ? formatGroupIdForContainer(groupId) : undefined;
      // Container API uses `recipient` for both DMs and groups.
      // For groups, pass the formatted group ID as recipient.
      const effectiveRecipient = formattedGroupId || recipient || "";
      const reactionParams = {
        baseUrl: opts.baseUrl,
        account: (p.account as string) ?? "",
        recipient: effectiveRecipient,
        emoji: (p.emoji as string) ?? "",
        targetAuthor: stripUuidPrefix((p.targetAuthor as string) ?? recipient),
        targetTimestamp: p.targetTimestamp as number,
        groupId: formattedGroupId,
        timeoutMs: opts.timeoutMs,
      };
      const fn = p.remove ? containerRemoveReaction : containerSendReaction;
      return (await fn(reactionParams)) as T;
    }

    case "getAttachment": {
      const attachmentId = p.id as string;
      const buffer = await containerFetchAttachment(attachmentId, {
        baseUrl: opts.baseUrl,
        timeoutMs: opts.timeoutMs,
        maxResponseBytes: opts.maxResponseBytes,
      });
      // Convert to native format: { data: base64String }
      if (!buffer) {
        return { data: undefined } as T;
      }
      return { data: buffer.toString("base64") } as T;
    }

    case "version": {
      const result = await containerRestRequest<{ versions?: string[]; build?: number }>(
        "/v1/about",
        { baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs },
      );
      return result as T;
    }

    default:
      throw new Error(`Unsupported container RPC method: ${method}`);
  }
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
