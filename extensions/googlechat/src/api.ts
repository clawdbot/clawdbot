// Googlechat API module exposes the plugin public contract.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  parseMediaContentLength,
  readResponseTextSnippet,
} from "openclaw/plugin-sdk/media-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { shouldSuppressGoogleChatManualExecApprovalFollowupText } from "./approval-card-actions.js";
import { getGoogleChatAccessToken } from "./auth.js";
import type { GoogleChatCardV2, GoogleChatSpace } from "./types.js";

const CHAT_API_BASE = "https://chat.googleapis.com/v1";
const GOOGLECHAT_API_TIMEOUT_MS = 30_000;
const GOOGLECHAT_MEDIA_TIMEOUT_GRACE_MS = 30_000;
const GOOGLECHAT_MEDIA_MIN_BYTES_PER_SECOND = 256 * 1024;
const GOOGLECHAT_MEDIA_MAX_TIMEOUT_MS = 15 * 60_000;
const GOOGLECHAT_RESPONSE_READ_IDLE_TIMEOUT_MS = 30_000;
const GOOGLECHAT_JSON_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const GOOGLECHAT_ERROR_BODY_MAX_BYTES = 16 * 1024;
const GOOGLE_CHAT_MEDIA_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

function resolveGoogleChatMediaTimeoutMs(maxBytes?: number): number {
  if (!maxBytes) {
    return GOOGLECHAT_MEDIA_MAX_TIMEOUT_MS;
  }
  const transferMs = Math.ceil((maxBytes / GOOGLECHAT_MEDIA_MIN_BYTES_PER_SECOND) * 1000);
  return Math.min(GOOGLECHAT_MEDIA_TIMEOUT_GRACE_MS + transferMs, GOOGLECHAT_MEDIA_MAX_TIMEOUT_MS);
}

async function readGoogleChatJsonResponse<T>(response: Response, label: string): Promise<T> {
  const bytes = await readResponseWithLimit(response, GOOGLECHAT_JSON_RESPONSE_MAX_BYTES, {
    chunkTimeoutMs: GOOGLECHAT_RESPONSE_READ_IDLE_TIMEOUT_MS,
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`${label}: response body stalled after ${chunkTimeoutMs}ms`),
    onOverflow: ({ maxBytes }) => new Error(`${label}: JSON response exceeds ${maxBytes} bytes`),
  });
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (cause) {
    throw new Error(`${label}: malformed JSON response`, { cause });
  }
}

async function readGoogleChatErrorResponse(response: Response, label: string): Promise<string> {
  return (
    (await readResponseTextSnippet(response, {
      maxBytes: GOOGLECHAT_ERROR_BODY_MAX_BYTES,
      maxChars: GOOGLECHAT_ERROR_BODY_MAX_BYTES,
      chunkTimeoutMs: GOOGLECHAT_RESPONSE_READ_IDLE_TIMEOUT_MS,
      onIdleTimeout: ({ chunkTimeoutMs }) =>
        new Error(`${label} error response stalled after ${chunkTimeoutMs}ms`),
    })) ?? ""
  );
}

const headersToObject = (headers?: HeadersInit): Record<string, string> =>
  headers instanceof Headers
    ? Object.fromEntries(headers.entries())
    : Array.isArray(headers)
      ? Object.fromEntries(headers)
      : headers || {};

async function withGoogleChatResponse<T>(params: {
  account: ResolvedGoogleChatAccount;
  url: string;
  init?: RequestInit;
  auditContext: string;
  errorPrefix?: string;
  timeoutMs?: number;
  handleResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  const {
    account,
    url,
    init,
    auditContext,
    errorPrefix = "Google Chat API",
    timeoutMs = GOOGLECHAT_API_TIMEOUT_MS,
    handleResponse,
  } = params;
  const token = await getGoogleChatAccessToken(account);
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      ...init,
      headers: {
        ...headersToObject(init?.headers),
        Authorization: `Bearer ${token}`,
      },
    },
    auditContext,
    timeoutMs,
  });
  try {
    if (!response.ok) {
      const text = await readGoogleChatErrorResponse(response, errorPrefix);
      throw new Error(`${errorPrefix} ${response.status}: ${text || response.statusText}`);
    }
    return await handleResponse(response);
  } finally {
    await release();
  }
}

async function fetchJson<T>(
  account: ResolvedGoogleChatAccount,
  url: string,
  init: RequestInit,
): Promise<T> {
  return await withGoogleChatResponse({
    account,
    url,
    init: {
      ...init,
      headers: {
        ...headersToObject(init.headers),
        "Content-Type": "application/json",
      },
    },
    auditContext: "googlechat.api.json",
    handleResponse: async (response) =>
      await readGoogleChatJsonResponse<T>(response, "Google Chat API request failed"),
  });
}

async function fetchOk(
  account: ResolvedGoogleChatAccount,
  url: string,
  init: RequestInit,
): Promise<void> {
  await withGoogleChatResponse({
    account,
    url,
    init,
    auditContext: "googlechat.api.ok",
    handleResponse: async () => undefined,
  });
}

async function fetchBuffer(
  account: ResolvedGoogleChatAccount,
  url: string,
  init?: RequestInit,
  options?: { maxBytes?: number },
): Promise<{ buffer: Buffer; contentType?: string }> {
  return await withGoogleChatResponse({
    account,
    url,
    init,
    auditContext: "googlechat.api.buffer",
    // Media gets transfer time proportional to its accepted size, while a silent
    // response body is still bounded independently below.
    timeoutMs: resolveGoogleChatMediaTimeoutMs(options?.maxBytes),
    handleResponse: async (res) => {
      const maxBytes = options?.maxBytes ?? GOOGLE_CHAT_MEDIA_RESPONSE_MAX_BYTES;
      const lengthHeader = res.headers.get("content-length");
      if (lengthHeader) {
        const length = parseMediaContentLength(lengthHeader);
        if (length !== null && length > maxBytes) {
          throw new Error(`Google Chat media exceeds max bytes (${maxBytes})`);
        }
      }
      const buffer = await readResponseWithLimit(res, maxBytes, {
        chunkTimeoutMs: GOOGLECHAT_RESPONSE_READ_IDLE_TIMEOUT_MS,
        onOverflow: () => new Error(`Google Chat media exceeds max bytes (${maxBytes})`),
      });
      const contentType = res.headers.get("content-type") ?? undefined;
      return { buffer, contentType };
    },
  });
}

export async function sendGoogleChatMessage(params: {
  account: ResolvedGoogleChatAccount;
  space: string;
  text?: string;
  thread?: string;
  cardsV2?: GoogleChatCardV2[];
}): Promise<{ messageName?: string; threadName?: string } | null> {
  const { account, space, text, thread, cardsV2 } = params;
  if (
    text &&
    (!cardsV2 || cardsV2.length === 0) &&
    shouldSuppressGoogleChatManualExecApprovalFollowupText(text)
  ) {
    return null;
  }
  const body: Record<string, unknown> = {};
  if (text) {
    body.text = text;
  }
  if (cardsV2 && cardsV2.length > 0) {
    body.cardsV2 = cardsV2;
  }
  if (thread) {
    body.thread = { name: thread };
  }
  const urlObj = new URL(`${CHAT_API_BASE}/${space}/messages`);
  if (thread) {
    urlObj.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
  }
  const url = urlObj.toString();
  const result = await fetchJson<{ name?: string; thread?: { name?: string } }>(account, url, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return result ? { messageName: result.name, threadName: result.thread?.name } : null;
}

export async function updateGoogleChatMessage(params: {
  account: ResolvedGoogleChatAccount;
  messageName: string;
  text?: string;
  cardsV2?: GoogleChatCardV2[];
}): Promise<{ messageName?: string }> {
  const { account, messageName, text, cardsV2 } = params;
  const updateMask = [
    ...(text !== undefined ? ["text"] : []),
    ...(cardsV2 !== undefined ? ["cardsV2"] : []),
  ];
  if (updateMask.length === 0) {
    throw new Error("Google Chat message update requires text or cardsV2.");
  }
  const url = `${CHAT_API_BASE}/${messageName}?updateMask=${updateMask.join(",")}`;
  const body: Record<string, unknown> = {};
  if (text !== undefined) {
    body.text = text;
  }
  if (cardsV2 !== undefined) {
    body.cardsV2 = cardsV2;
  }
  const result = await fetchJson<{ name?: string }>(account, url, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return { messageName: result.name };
}

export async function deleteGoogleChatMessage(params: {
  account: ResolvedGoogleChatAccount;
  messageName: string;
}): Promise<void> {
  const { account, messageName } = params;
  const url = `${CHAT_API_BASE}/${messageName}`;
  await fetchOk(account, url, { method: "DELETE" });
}

export async function downloadGoogleChatMedia(params: {
  account: ResolvedGoogleChatAccount;
  resourceName: string;
  maxBytes?: number;
}): Promise<{ buffer: Buffer; contentType?: string }> {
  const { account, resourceName, maxBytes } = params;
  const url = `${CHAT_API_BASE}/media/${resourceName}?alt=media`;
  return await fetchBuffer(account, url, undefined, { maxBytes });
}

export async function findGoogleChatDirectMessage(params: {
  account: ResolvedGoogleChatAccount;
  userName: string;
}): Promise<GoogleChatSpace | null> {
  const { account, userName } = params;
  const url = new URL(`${CHAT_API_BASE}/spaces:findDirectMessage`);
  url.searchParams.set("name", userName);
  return await fetchJson<GoogleChatSpace>(account, url.toString(), {
    method: "GET",
  });
}

export async function getGoogleChatSpace(params: {
  account: ResolvedGoogleChatAccount;
  spaceName: string;
}): Promise<GoogleChatSpace> {
  return await fetchJson<GoogleChatSpace>(params.account, `${CHAT_API_BASE}/${params.spaceName}`, {
    method: "GET",
  });
}

export async function probeGoogleChat(account: ResolvedGoogleChatAccount): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
}> {
  try {
    const url = new URL(`${CHAT_API_BASE}/spaces`);
    url.searchParams.set("pageSize", "1");
    await fetchJson<Record<string, unknown>>(account, url.toString(), {
      method: "GET",
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: formatErrorMessage(err),
    };
  }
}
