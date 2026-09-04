// GPT-Live frameless session, call-creation, and sideband event wire contracts.
import { randomBytes } from "node:crypto";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/realtime-voice-provider";
import { readResponseTextPrefix } from "openclaw/plugin-sdk/response-limit-runtime";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
import {
  buildOpenAIQuicksilverBackgroundContext,
  OPENAI_QUICKSILVER_HOST_CONTROL_INSTRUCTIONS,
} from "./realtime-quicksilver-instructions.js";
import {
  isOpenAIGptLiveModel,
  resolveOpenAIQuicksilverVoice,
  type OpenAIGptLiveVoice,
} from "./realtime-quicksilver.js";

const OPENAI_QUICKSILVER_APPEND_MAX_BYTES = 500;
const OPENAI_QUICKSILVER_DELEGATION_RESULT_MAX_CHARS = 1_800;
const OPENAI_QUICKSILVER_CONTEXT_MAX_ENTRIES = 16;
const OPENAI_QUICKSILVER_CONTEXT_MAX_ITEM_CHARS = 800;
const OPENAI_QUICKSILVER_CONTEXT_MAX_UTF8_BYTES = 8_000;
const OPENAI_QUICKSILVER_CALL_URL = "https://api.openai.com/v1/live";
const OPENAI_CHATGPT_QUICKSILVER_CALL_URL =
  "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const OPENAI_REALTIME_CALL_URL = "https://api.openai.com/v1/realtime/calls";
const OPENAI_REALTIME_ERROR_BODY_MAX_BYTES = 16 * 1024;
const OPENAI_REALTIME_ERROR_DETAIL_MAX_CHARS = 500;
const OPENAI_REALTIME_SDP_ANSWER_MAX_BYTES = 256 * 1024;
const OPENAI_REALTIME_LOCATION_MAX_BYTES = 512;
const OPENAI_REALTIME_CALL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/u;
const OPENAI_GPT_LIVE_WAITLIST_URL = "https://openai.com/form/gpt-live-1-in-the-api/";

function redactOpenAIRealtimeErrorDetail(
  text: string,
  auth: OpenAIQuicksilverAuth,
  redactSensitiveText: OpenAIRealtimeHost["redactSensitiveText"],
): string {
  let redacted = text;
  const exactSecrets = [auth.token, auth.type === "oauth" ? auth.accountId : undefined];
  for (const secret of exactSecrets) {
    if (secret) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redactSensitiveText(redacted, { mode: "tools" });
}

export type OpenAIQuicksilverAuth =
  | { type: "api-key"; token: string }
  | { type: "oauth"; token: string; accountId: string };

export type OpenAIQuicksilverRequestIds = {
  realtimeSessionId: string;
  sessionId: string;
  threadId: string;
};

export type OpenAIQuicksilverInitialItem = {
  role: "user" | "assistant";
  text: string;
};

type OpenAIQuicksilverSession = {
  model: string;
  instructions: string;
  audio: { output: { voice: OpenAIGptLiveVoice } };
  delegation: { type: "client"; ack_filler?: false };
  initial_items?: Array<{
    type: "message";
    role: "user" | "assistant";
    content: Array<{ type: "input_text" | "output_text"; text: string }>;
  }>;
};

type OpenAIQuicksilverSessionUpdate = {
  type: "session.update";
  session: Omit<OpenAIQuicksilverSession, "model">;
};

export { parseOpenAIQuicksilverEvent } from "./realtime-quicksilver-events.js";
export type { OpenAIQuicksilverInboundEvent } from "./realtime-quicksilver-events.js";

class OpenAIQuicksilverCallError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OpenAIQuicksilverCallError";
  }
}

export function buildOpenAIQuicksilverSession(params: {
  model: string;
  hostControlsInput?: boolean;
  instructions?: string;
  voice?: string;
  initialItems?: readonly OpenAIQuicksilverInitialItem[];
}): OpenAIQuicksilverSession {
  const history = boundOpenAIQuicksilverContextItems(params.initialItems ?? []);
  const instructions = [
    params.instructions?.trim(),
    params.hostControlsInput ? OPENAI_QUICKSILVER_HOST_CONTROL_INSTRUCTIONS : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
  // Negotiated host-controlled calls receive shared history as background, not
  // as the new call's own speech. Explicit legacy conversation seeds stay native.
  const initialItems = (params.hostControlsInput ? [] : history).map((item) => ({
    type: "message" as const,
    role: item.role,
    content: [
      {
        type: item.role === "assistant" ? ("output_text" as const) : ("input_text" as const),
        text: item.text,
      },
    ],
  }));
  return {
    model: params.model,
    instructions:
      instructions +
      (params.hostControlsInput
        ? buildOpenAIQuicksilverBackgroundContext(
            history,
            OPENAI_QUICKSILVER_CONTEXT_MAX_UTF8_BYTES,
          )
        : ""),
    audio: { output: { voice: resolveOpenAIQuicksilverVoice(params.voice) } },
    // Set at call creation: an attached sideband cannot change existing-call configuration.
    delegation: params.hostControlsInput
      ? { type: "client", ack_filler: false }
      : { type: "client" },
    ...(initialItems && initialItems.length > 0 ? { initial_items: initialItems } : {}),
  };
}

/** Builds the direct Frameless Bidi WebSocket handshake used by Codex realtime v3. */
export function buildOpenAIQuicksilverSessionUpdate(params: {
  instructions?: string;
  voice?: string;
  initialItems?: readonly OpenAIQuicksilverInitialItem[];
}): OpenAIQuicksilverSessionUpdate {
  const { model: _model, ...session } = buildOpenAIQuicksilverSession({
    model: "direct-websocket",
    ...params,
  });
  return { type: "session.update", session };
}

export function buildOpenAIQuicksilverWebSocketUrl(model: string): string {
  const url = new URL(OPENAI_QUICKSILVER_CALL_URL);
  url.protocol = "wss:";
  url.searchParams.set("model", model);
  return url.toString();
}

function truncateOpenAIQuicksilverContextText(text: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  let characters = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (
      characters >= OPENAI_QUICKSILVER_CONTEXT_MAX_ITEM_CHARS ||
      bytes + characterBytes > maxBytes
    ) {
      break;
    }
    result += character;
    bytes += characterBytes;
    characters += 1;
  }
  return result;
}

export function boundOpenAIQuicksilverContextItems(
  items: readonly OpenAIQuicksilverInitialItem[],
): OpenAIQuicksilverInitialItem[] {
  let remainingBytes = OPENAI_QUICKSILVER_CONTEXT_MAX_UTF8_BYTES;
  const newestFirst: OpenAIQuicksilverInitialItem[] = [];
  for (
    let index = items.length - 1;
    index >= 0 && newestFirst.length < OPENAI_QUICKSILVER_CONTEXT_MAX_ENTRIES;
    index -= 1
  ) {
    const item = items[index];
    if (!item || remainingBytes <= 0) {
      continue;
    }
    const text = truncateOpenAIQuicksilverContextText(item.text, remainingBytes);
    if (!text) {
      continue;
    }
    newestFirst.push({ role: item.role, text });
    remainingBytes -= Buffer.byteLength(text, "utf8");
  }
  return newestFirst.toReversed();
}

export function openAIQuicksilverAuthHeaders(
  auth: OpenAIQuicksilverAuth,
  requestIds: OpenAIQuicksilverRequestIds,
  runtime: OpenAIRealtimeHost,
): Record<string, string> {
  return openAIRealtimeAuthHeaders(
    {
      auth,
      requestIds,
      baseUrl: OPENAI_QUICKSILVER_CALL_URL,
      includeQuicksilverAlpha: true,
    },
    runtime,
  );
}

function openAIRealtimeAuthHeaders(
  params: {
    auth: OpenAIQuicksilverAuth;
    requestIds: OpenAIQuicksilverRequestIds;
    baseUrl: string;
    includeQuicksilverAlpha: boolean;
  },
  { resolveProviderRequestHeaders }: OpenAIRealtimeHost,
): Record<string, string> {
  const attributionHeaders =
    resolveProviderRequestHeaders({
      provider: "openai",
      baseUrl: params.baseUrl,
      capability: "audio",
      transport: "http",
      defaultHeaders: {},
    }) ?? {};
  // x-oai-attestation is optional and intentionally omitted on unsupported clients.
  return {
    ...attributionHeaders,
    Authorization: `Bearer ${params.auth.token}`,
    ...(params.includeQuicksilverAlpha ? { "OpenAI-Alpha": "quicksilver=v2" } : {}),
    "session-id": params.requestIds.sessionId,
    "thread-id": params.requestIds.threadId,
    "x-session-id": params.requestIds.realtimeSessionId,
    ...(params.auth.type === "oauth"
      ? {
          "chatgpt-account-id": params.auth.accountId,
        }
      : {}),
  };
}

function buildOpenAIQuicksilverMultipartBody(params: { sdp: string; session: unknown }): {
  body: string;
  contentType: string;
} {
  const sessionJson = JSON.stringify(params.session);
  let boundary: string;
  do {
    boundary = `openclaw-quicksilver-${randomBytes(18).toString("hex")}`;
  } while (params.sdp.includes(boundary) || sessionJson.includes(boundary));
  return {
    body: [
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="sdp"\r\n',
      "Content-Type: application/sdp\r\n\r\n",
      params.sdp,
      "\r\n",
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="session"\r\n',
      "Content-Type: application/json\r\n\r\n",
      sessionJson,
      "\r\n",
      `--${boundary}--\r\n`,
    ].join(""),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function parseOpenAIRealtimeCallLocation(location: string | null): string {
  if (!location) {
    throw new Error("OpenAI Realtime call response is missing the Location header");
  }
  if (Buffer.byteLength(location, "utf8") > OPENAI_REALTIME_LOCATION_MAX_BYTES) {
    throw new Error("OpenAI Realtime call response Location header is too large");
  }
  let url: URL;
  try {
    url = new URL(location, OPENAI_REALTIME_CALL_URL);
  } catch {
    throw new Error("OpenAI Realtime call response Location header is invalid");
  }
  if (url.origin !== "https://api.openai.com" || url.search || url.hash) {
    throw new Error("OpenAI Realtime call response Location header has an unexpected target");
  }
  const match = /^\/v1\/realtime\/calls\/([^/]+)\/?$/u.exec(url.pathname);
  if (!match?.[1] || !OPENAI_REALTIME_CALL_ID_RE.test(match[1])) {
    throw new Error("OpenAI Realtime call response Location header has no valid call id");
  }
  return match[1];
}

export function buildOpenAIRealtimeSidebandUrl(callId: string): string {
  if (!OPENAI_REALTIME_CALL_ID_RE.test(callId)) {
    throw new Error("OpenAI Realtime call id is invalid");
  }
  const url = new URL("wss://api.openai.com/v1/realtime");
  url.searchParams.set("call_id", callId);
  return url.toString();
}

function isOpenAIQuicksilverCallId(value: string): boolean {
  return (
    /^rtc_[\w-]+$/.test(value) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function decodeOpenAIQuicksilverCallId(params: {
  location: string | null;
  openAiSessionId: string | null;
  callUrl: string;
}): string {
  const sessionId = params.openAiSessionId?.trim() ?? "";
  if (!params.location) {
    if (isOpenAIQuicksilverCallId(sessionId)) {
      return sessionId;
    }
    throw new OpenAIQuicksilverCallError(
      sessionId
        ? "GPT-Live call response returned an invalid openai-session-id"
        : "GPT-Live call response missing Location and openai-session-id headers",
    );
  }
  let pathname: string;
  try {
    pathname = new URL(params.location, params.callUrl).pathname;
  } catch {
    if (isOpenAIQuicksilverCallId(sessionId)) {
      return sessionId;
    }
    throw new OpenAIQuicksilverCallError("GPT-Live call response returned an invalid Location");
  }
  const callId = pathname.split("/").filter(Boolean).find(isOpenAIQuicksilverCallId);
  if (!callId) {
    if (isOpenAIQuicksilverCallId(sessionId)) {
      return sessionId;
    }
    throw new OpenAIQuicksilverCallError("GPT-Live call response Location has no valid call id");
  }
  return callId;
}

function describeOpenAIQuicksilverCallError(
  status: number,
  detail: string,
  auth: OpenAIQuicksilverAuth,
): string {
  const normalized = detail.toLowerCase();
  if (status === 403) {
    return "GPT-Live rejected the session (403). Verify the selected OpenAI account, model, and GPT-Live voice; this response alone does not identify which was denied.";
  }
  if (
    status === 400 &&
    auth.type === "api-key" &&
    (normalized.includes("model_not_found") ||
      normalized.includes("does not exist or you do not have access"))
  ) {
    return `OpenAI Platform API-key access to /v1/live is waitlist-gated. Use a ChatGPT OAuth profile or request access at ${OPENAI_GPT_LIVE_WAITLIST_URL}`;
  }
  if (
    status === 400 &&
    normalized.includes("session.model") &&
    normalized.includes("not allowed")
  ) {
    return "The GPT-Live model value is not permitted. Choose a supported GPT-Live model in Settings > Talk.";
  }
  return `GPT-Live call creation failed (${status})${detail ? `: ${detail}` : ""}`;
}

export async function createOpenAIQuicksilverCall(
  params: {
    auth: OpenAIQuicksilverAuth;
    sdp: string;
    session: OpenAIQuicksilverSession | (Record<string, unknown> & { model: string });
    requestIds: OpenAIQuicksilverRequestIds;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } & ({ gaSideband: true; onCallAllocated: (callId: string) => void } | { gaSideband?: false }),
  runtime: OpenAIRealtimeHost,
): Promise<
  | {
      kind: "gpt-live";
      status: number;
      answerSdp: string;
      callId: string;
      sidebandUrl: string;
    }
  | { kind: "ga-realtime"; status: number; answerSdp: string }
  | {
      kind: "ga-sideband";
      status: number;
      answerSdp: string;
      callId: string;
      sidebandUrl: string;
    }
> {
  const isGptLive = isOpenAIGptLiveModel(params.session.model);
  if (params.gaSideband && (isGptLive || params.auth.type !== "api-key")) {
    throw new Error("OpenAI Realtime Gateway control requires a GA model and Platform API key");
  }
  const chatGptCall = isGptLive && params.auth.type === "oauth";
  const callUrl = chatGptCall
    ? OPENAI_CHATGPT_QUICKSILVER_CALL_URL
    : isGptLive
      ? OPENAI_QUICKSILVER_CALL_URL
      : OPENAI_REALTIME_CALL_URL;
  const authHeaders = openAIRealtimeAuthHeaders(
    {
      auth: params.auth,
      requestIds: params.requestIds,
      baseUrl: callUrl,
      includeQuicksilverAlpha: isGptLive,
    },
    runtime,
  );
  // ChatGPT call creation uses Codex's backend JSON contract; Platform uses multipart.
  // Both return a call id whose sideband remains on the public /v1/live endpoint.
  const payload = { sdp: params.sdp, session: params.session };
  const requestBody = chatGptCall
    ? { body: JSON.stringify(payload), contentType: "application/json" }
    : buildOpenAIQuicksilverMultipartBody(payload);

  const response = await (params.fetchImpl ?? fetch)(callUrl, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": requestBody.contentType,
    },
    body: requestBody.body,
    signal: params.signal,
  });
  if (!response.ok) {
    // Provider failures are untrusted streams. Bound and cancel unread overflow
    // before retaining the short diagnostic included in the user-facing error.
    // A truncated prefix can end inside an OAuth identifier. Exact redaction
    // cannot prove that a partial suffix is safe, so omit provider detail.
    const providerDetail = await readResponseTextPrefix(
      response,
      OPENAI_REALTIME_ERROR_BODY_MAX_BYTES,
    ).catch(() => undefined);
    const detail = providerDetail?.truncated
      ? ""
      : truncateUtf16Safe(
          redactOpenAIRealtimeErrorDetail(
            providerDetail?.text.trim() ?? "",
            params.auth,
            runtime.redactSensitiveText,
          ),
          OPENAI_REALTIME_ERROR_DETAIL_MAX_CHARS,
        );
    throw new OpenAIQuicksilverCallError(
      isGptLive
        ? describeOpenAIQuicksilverCallError(response.status, detail, params.auth)
        : `OpenAI Realtime call creation failed (${response.status})${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }
  let gaCallId: string | undefined;
  if (params.gaSideband) {
    try {
      gaCallId = parseOpenAIRealtimeCallLocation(response.headers.get("Location"));
      // The successful headers allocate a remote resource even if SDP reading fails.
      params.onCallAllocated(gaCallId);
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
  }
  const answerSdp = await runtime.readProviderTextResponse(
    response,
    `${isGptLive ? "GPT-Live" : "OpenAI Realtime"} SDP answer`,
    { maxBytes: OPENAI_REALTIME_SDP_ANSWER_MAX_BYTES },
  );
  if (!answerSdp.trim()) {
    throw new OpenAIQuicksilverCallError(
      `${isGptLive ? "GPT-Live" : "OpenAI Realtime"} call creation returned an empty SDP answer`,
      response.status,
    );
  }
  if (gaCallId) {
    return {
      kind: "ga-sideband",
      status: response.status,
      answerSdp,
      callId: gaCallId,
      sidebandUrl: buildOpenAIRealtimeSidebandUrl(gaCallId),
    };
  }
  if (!isGptLive) {
    return { kind: "ga-realtime", status: response.status, answerSdp };
  }
  const callId = decodeOpenAIQuicksilverCallId({
    location: response.headers.get("Location"),
    openAiSessionId: response.headers.get("openai-session-id"),
    callUrl,
  });
  return {
    kind: "gpt-live",
    status: response.status,
    answerSdp,
    callId,
    sidebandUrl: `wss://api.openai.com/v1/live/${callId}`,
  };
}

export async function hangupOpenAIRealtimeCall(
  params: {
    apiKey: string;
    callId: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  },
  { resolveProviderRequestHeaders }: OpenAIRealtimeHost,
): Promise<void> {
  if (!OPENAI_REALTIME_CALL_ID_RE.test(params.callId)) {
    throw new Error("OpenAI Realtime call id is invalid");
  }
  const url = `${OPENAI_REALTIME_CALL_URL}/${encodeURIComponent(params.callId)}/hangup`;
  const headers = resolveProviderRequestHeaders({
    provider: "openai",
    baseUrl: url,
    capability: "audio",
    transport: "http",
    defaultHeaders: { Authorization: `Bearer ${params.apiKey}` },
  }) ?? { Authorization: `Bearer ${params.apiKey}` };
  const response = await (params.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers,
    signal: params.signal,
  });
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok && response.status !== 404) {
    throw new Error(`OpenAI Realtime call hangup failed (${response.status})`);
  }
}

export function chunkOpenAIQuicksilverAppendText(text: string): string[] {
  if (Buffer.byteLength(text, "utf8") <= OPENAI_QUICKSILVER_APPEND_MAX_BYTES) {
    return [text];
  }
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (current && currentBytes + characterBytes > OPENAI_QUICKSILVER_APPEND_MAX_BYTES) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

/** Bound completed delegation output while preserving under-limit text byte-for-byte. */
export function boundOpenAIQuicksilverDelegationResult(text: string): string {
  if (text.length <= OPENAI_QUICKSILVER_DELEGATION_RESULT_MAX_CHARS) {
    return text;
  }
  return `${truncateUtf16Safe(
    text,
    OPENAI_QUICKSILVER_DELEGATION_RESULT_MAX_CHARS - 16,
  ).trimEnd()} [truncated]`;
}
