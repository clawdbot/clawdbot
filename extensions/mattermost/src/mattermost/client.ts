// Mattermost plugin module implements client behavior.
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import {
  readProviderJsonResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromPrivateNetworkOptIn,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";

const MATTERMOST_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const MATTERMOST_REQUEST_TIMEOUT_MS = 30_000;
// Mattermost REST control-plane JSON (posts, users, channels, file-upload
// results) stays well under a megabyte; cap successful JSON the same way the
// shared provider path is capped so an untrusted/self-hosted homeserver cannot
// stream an unbounded body into the runtime before parsing.
// Non-JSON success bodies are a rare fallback (the API is JSON-first); keep a
// generous text budget but still bound it instead of buffering the whole stream.
const MATTERMOST_TEXT_RESPONSE_LIMIT_BYTES = 64 * 1024;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export type MattermostFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type MattermostRequestInit = RequestInit & {
  timeoutMs?: number;
};

export type MattermostClient = {
  baseUrl: string;
  apiBaseUrl: string;
  token: string;
  request: <T>(path: string, init?: MattermostRequestInit) => Promise<T>;
  /** Guarded fetch implementation; use in place of raw fetch for outbound requests. */
  fetchImpl: MattermostFetch;
};

export type MattermostUser = {
  id: string;
  username?: string | null;
  nickname?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  update_at?: number;
};

export type MattermostChannel = {
  id: string;
  name?: string | null;
  display_name?: string | null;
  type?: string | null;
  team_id?: string | null;
};

export const MattermostPostSchema = z
  .object({
    id: z.string(),
    user_id: z.string().nullable().optional(),
    channel_id: z.string().nullable().optional(),
    message: z.string().nullable().optional(),
    file_ids: z.array(z.string()).nullable().optional(),
    type: z.string().nullable().optional(),
    root_id: z.string().nullable().optional(),
    create_at: z.number().nullable().optional(),
    props: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();

export type MattermostPost = z.infer<typeof MattermostPostSchema>;

type MattermostFileInfo = {
  id: string;
  name?: string | null;
  mime_type?: string | null;
  size?: number | null;
};

export function normalizeMattermostBaseUrl(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutTrailing = trimmed.replace(/\/+$/, "");
  return withoutTrailing.replace(/\/api\/v4$/i, "");
}

function buildMattermostApiUrl(baseUrl: string, path: string): string {
  const normalized = normalizeMattermostBaseUrl(baseUrl);
  if (!normalized) {
    throw new Error("Mattermost baseUrl is required");
  }
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${normalized}/api/v4${suffix}`;
}

async function readMattermostSuccessText(res: Response, path: string): Promise<string> {
  const bytes = await readResponseWithLimit(res, MATTERMOST_TEXT_RESPONSE_LIMIT_BYTES, {
    onOverflow: ({ maxBytes }) =>
      new Error(`Mattermost API ${path}: text response exceeds ${maxBytes} bytes`),
  });
  return new TextDecoder().decode(bytes);
}

export async function readMattermostError(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await readResponseTextLimited(res, MATTERMOST_ERROR_BODY_LIMIT_BYTES);
  if (contentType.includes("application/json")) {
    try {
      const data = JSON.parse(text) as { message?: string } | undefined;
      if (data?.message) {
        return data.message;
      }
      return JSON.stringify(data);
    } catch {
      return text;
    }
  }
  return text;
}

function responseWithRelease(response: Response, release: () => Promise<void>): Response {
  let released = false;
  const releaseOnce = async () => {
    if (released) {
      return;
    }
    released = true;
    await release();
  };

  if (!response.body || NULL_BODY_STATUSES.has(response.status)) {
    void releaseOnce();
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await releaseOnce();
          controller.close();
          return;
        }
        if (value) {
          controller.enqueue(value);
        }
      } catch (error) {
        await releaseOnce();
        throw error;
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await releaseOnce();
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createMattermostClient(params: {
  baseUrl: string;
  botToken: string;
  fetchImpl?: MattermostFetch;
  /** Timeout for REST requests in milliseconds (default: 30000). */
  timeoutMs?: number;
  /** Allow requests to private/internal IPs (self-hosted/LAN deployments). */
  allowPrivateNetwork?: boolean;
}): MattermostClient {
  const baseUrl = normalizeMattermostBaseUrl(params.baseUrl);
  if (!baseUrl) {
    throw new Error("Mattermost baseUrl is required");
  }
  const apiBaseUrl = `${baseUrl}/api/v4`;
  const token = params.botToken.trim();
  const requestTimeoutMs = resolveTimerTimeoutMs(params.timeoutMs, MATTERMOST_REQUEST_TIMEOUT_MS);
  // When no custom fetchImpl is provided (production path), use an SSRF-guarded wrapper
  // that validates the target URL before making the request (DNS rebinding protection etc.).
  // A custom fetchImpl is accepted for testing and special cases.
  const externalFetchImpl = params.fetchImpl;

  const guardedFetchImpl = async (
    input: RequestInfo | URL,
    init?: MattermostRequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const { timeoutMs: initTimeoutMs, ...requestInit } = init ?? {};
    const timeoutMs = resolveTimerTimeoutMs(initTimeoutMs, requestTimeoutMs);
    const { response, release } = await fetchWithSsrFGuard({
      url,
      init: requestInit,
      auditContext: "mattermost-api",
      policy: ssrfPolicyFromPrivateNetworkOptIn(params.allowPrivateNetwork),
      signal: requestInit.signal ?? undefined,
      timeoutMs,
    });
    return responseWithRelease(response, release);
  };

  const timedExternalFetchImpl:
    | ((input: RequestInfo | URL, init?: MattermostRequestInit) => Promise<Response>)
    | undefined = externalFetchImpl
    ? async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const { timeoutMs: initTimeoutMs, ...requestInit } = init ?? {};
        const timeoutMs = resolveTimerTimeoutMs(initTimeoutMs, requestTimeoutMs);
        const { signal: timeoutSignal, cleanup } = buildTimeoutAbortSignal({
          timeoutMs,
          operation: "mattermost-api",
          url,
        });
        const callerSignal = requestInit.signal ?? undefined;
        const signal =
          callerSignal && timeoutSignal
            ? AbortSignal.any([callerSignal, timeoutSignal])
            : (callerSignal ?? timeoutSignal);
        try {
          const response = await externalFetchImpl(input, { ...requestInit, signal });
          // Match guarded production fetches: retain cancellation and the
          // request deadline until the custom response body is consumed.
          return responseWithRelease(response, async () => cleanup());
        } catch (error) {
          cleanup();
          throw error;
        }
      }
    : undefined;

  const fetchImpl = timedExternalFetchImpl ?? guardedFetchImpl;

  const request = async <T>(path: string, init?: MattermostRequestInit): Promise<T> => {
    const url = buildMattermostApiUrl(baseUrl, path);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (typeof init?.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetchImpl(url, { ...init, headers });
    if (!res.ok) {
      const detail = await readMattermostError(res);
      throw new Error(
        `Mattermost API ${res.status} ${res.statusText}: ${detail || "unknown error"}`,
      );
    }

    if (res.status === 204) {
      return undefined as T;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return await readProviderJsonResponse<T>(res, `Mattermost API ${path}`);
    }
    return (await readMattermostSuccessText(res, path)) as T;
  };

  return { baseUrl, apiBaseUrl, token, request, fetchImpl };
}

export async function fetchMattermostMe(client: MattermostClient): Promise<MattermostUser> {
  return await client.request<MattermostUser>("/users/me");
}

export async function fetchMattermostUser(
  client: MattermostClient,
  userId: string,
): Promise<MattermostUser> {
  return await client.request<MattermostUser>(`/users/${userId}`);
}

export async function fetchMattermostUserByUsername(
  client: MattermostClient,
  username: string,
): Promise<MattermostUser> {
  return await client.request<MattermostUser>(`/users/username/${encodeURIComponent(username)}`);
}

export async function fetchMattermostChannel(
  client: MattermostClient,
  channelId: string,
): Promise<MattermostChannel> {
  return await client.request<MattermostChannel>(`/channels/${channelId}`);
}

export async function fetchMattermostChannelByName(
  client: MattermostClient,
  teamId: string,
  channelName: string,
): Promise<MattermostChannel> {
  return await client.request<MattermostChannel>(
    `/teams/${teamId}/channels/name/${encodeURIComponent(channelName)}`,
  );
}

export async function sendMattermostTyping(
  client: MattermostClient,
  params: { channelId: string; parentId?: string },
): Promise<void> {
  const payload: Record<string, string> = {
    channel_id: params.channelId,
  };
  const parentId = params.parentId?.trim();
  if (parentId) {
    payload.parent_id = parentId;
  }
  await client.request<Record<string, unknown>>("/users/me/typing", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function createMattermostDirectChannel(
  client: MattermostClient,
  userIds: string[],
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<MattermostChannel> {
  return await client.request<MattermostChannel>("/channels/direct", {
    method: "POST",
    body: JSON.stringify(userIds),
    signal,
    timeoutMs,
  });
}

export type CreateDmChannelRetryOptions = {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds (default: 10000) */
  maxDelayMs?: number;
  /** Timeout for each individual request in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Optional logger for retry events */
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
};

const DM_REPLY_DELIVERY_BARRIER_SLACK_MS = 60_000;

/** Covers DM creation retries without extending channel-delivery stalls. */
export function resolveMattermostReplyDeliveryBarrierTimeoutMs(params: {
  isDirect: boolean;
  dmRetryOptions?: CreateDmChannelRetryOptions;
  queuedCounts: Readonly<Record<"tool" | "block" | "final", number>>;
  humanDelayBudgetMs?: number;
}): number | undefined {
  if (!params.isDirect) {
    return undefined;
  }
  const deliveryCount = Object.values(params.queuedCounts).reduce((sum, count) => sum + count, 0);
  if (deliveryCount === 0) {
    return undefined;
  }
  const maxRetries = params.dmRetryOptions?.maxRetries ?? 3;
  const maxDelayMs = params.dmRetryOptions?.maxDelayMs ?? 10_000;
  const timeoutMs = params.dmRetryOptions?.timeoutMs ?? 30_000;
  const perDeliveryTimeoutMs =
    (maxRetries + 1) * timeoutMs + maxRetries * maxDelayMs + DM_REPLY_DELIVERY_BARRIER_SLACK_MS;
  const totalTimeoutMs =
    perDeliveryTimeoutMs * deliveryCount + Math.max(0, params.humanDelayBudgetMs ?? 0);
  return resolveTimerTimeoutMs(
    Number.isFinite(totalTimeoutMs) ? totalTimeoutMs : Number.MAX_SAFE_INTEGER,
    perDeliveryTimeoutMs,
  );
}

const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_DNS_RESOLVE_FAILED",
  "UND_ERR_CONNECT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const RETRYABLE_NETWORK_ERROR_NAMES = new Set([
  "AbortError",
  "TimeoutError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
]);

const RETRYABLE_NETWORK_MESSAGE_SNIPPETS = [
  "network error",
  "timeout",
  "timed out",
  "abort",
  "connection refused",
  "econnreset",
  "econnrefused",
  "etimedout",
  "enotfound",
  "socket hang up",
  "getaddrinfo",
];

/**
 * Creates a Mattermost DM channel with exponential backoff retry logic.
 * Retries on transient errors (429, 5xx, network errors) but not on
 * client errors (4xx except 429) or permanent failures.
 */
export async function createMattermostDirectChannelWithRetry(
  client: MattermostClient,
  userIds: string[],
  options: CreateDmChannelRetryOptions = {},
): Promise<MattermostChannel> {
  const {
    maxRetries = 3,
    initialDelayMs = 1000,
    maxDelayMs = 10000,
    timeoutMs: rawTimeoutMs = 30000,
    onRetry,
  } = options;
  const timeoutMs = resolveTimerTimeoutMs(rawTimeoutMs, 30000);

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Use AbortController for per-request timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const result = await createMattermostDirectChannel(
          client,
          userIds,
          controller.signal,
          timeoutMs,
        );
        return result;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry on the last attempt
      if (attempt >= maxRetries) {
        break;
      }

      // Check if error is retryable
      if (!isRetryableError(lastError)) {
        throw lastError;
      }

      // Calculate exponential backoff delay with full-jitter
      // Jitter is proportional to the exponential delay, not a fixed 1000ms
      // This ensures backoff behaves correctly for small delay configurations
      const exponentialDelay = initialDelayMs * 2 ** attempt;
      const jitter = Math.random() * exponentialDelay;
      const delayMs = Math.min(exponentialDelay + jitter, maxDelayMs);

      if (onRetry) {
        onRetry(attempt + 1, delayMs, lastError);
      }

      // Wait before retrying
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("Failed to create DM channel after retries");
}

function isRetryableError(error: Error): boolean {
  const candidates = collectErrorCandidates(error);
  const messages = candidates
    .map((candidate) => normalizeLowercaseStringOrEmpty(readErrorMessage(candidate)))
    .filter((message): message is string => Boolean(message));

  // Retry on 5xx server errors FIRST (before checking 4xx)
  // Use "mattermost api" prefix to avoid matching port numbers (e.g., :443) or IP octets
  // This prevents misclassification when a 5xx error detail contains a 4xx substring
  // e.g., "Mattermost API 503: upstream returned 404"
  if (messages.some((message) => /mattermost api 5\d{2}\b/.test(message))) {
    return true;
  }

  // Check for explicit 429 rate limiting FIRST (before generic "429" text match)
  // This avoids retrying when error detail contains "429" but it's not the status code
  if (
    messages.some(
      (message) => /mattermost api 429\b/.test(message) || message.includes("too many requests"),
    )
  ) {
    return true;
  }

  // Check for explicit 4xx status codes - these are client errors and should NOT be retried
  // (except 429 which is handled above)
  // Use "mattermost api" prefix to avoid matching port numbers like :443
  for (const message of messages) {
    const clientErrorMatch = message.match(/mattermost api (4\d{2})\b/);
    if (!clientErrorMatch) {
      continue;
    }
    const statusCode = Number.parseInt(clientErrorMatch[1], 10);
    if (statusCode >= 400 && statusCode < 500) {
      return false;
    }
  }

  // Retry on network/transient errors only if no explicit Mattermost API status code is present
  // This avoids false positives like:
  // - "400 Bad Request: connection timed out" (has status code)
  // - "connect ECONNRESET 104.18.32.10:443" (has port number, not status)
  const hasMattermostApiStatusCode = messages.some((message) =>
    /mattermost api \d{3}\b/.test(message),
  );
  if (hasMattermostApiStatusCode) {
    return false;
  }

  const codes: string[] = [];
  for (const candidate of candidates) {
    const code = readErrorCode(candidate);
    if (code) {
      codes.push(code);
    }
  }
  if (codes.some((code) => RETRYABLE_NETWORK_ERROR_CODES.has(code))) {
    return true;
  }

  const names: string[] = [];
  for (const candidate of candidates) {
    const name = readErrorName(candidate);
    if (name) {
      names.push(name);
    }
  }
  if (names.some((name) => RETRYABLE_NETWORK_ERROR_NAMES.has(name))) {
    return true;
  }

  return messages.some((message) =>
    RETRYABLE_NETWORK_MESSAGE_SNIPPETS.some((pattern) => message.includes(pattern)),
  );
}

function collectErrorCandidates(error: unknown): unknown[] {
  const queue: unknown[] = [error];
  let queueIndex = 0;
  const seen = new Set<unknown>();
  const candidates: unknown[] = [];

  while (queueIndex < queue.length) {
    const current = queue[queueIndex];
    queueIndex += 1;
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    candidates.push(current);

    if (typeof current !== "object") {
      continue;
    }

    const nested = current as {
      cause?: unknown;
      reason?: unknown;
      errors?: unknown;
    };
    queue.push(nested.cause, nested.reason);
    if (Array.isArray(nested.errors)) {
      queue.push(...nested.errors);
    }
  }

  return candidates;
}

function readErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : undefined;
}

function readErrorName(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && name.trim() ? name : undefined;
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const { code, errno } = error as {
    code?: unknown;
    errno?: unknown;
  };
  const raw = typeof code === "string" && code.trim() ? code : errno;
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim().toUpperCase();
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  return undefined;
}

export async function createMattermostPost(
  client: MattermostClient,
  params: {
    channelId: string;
    message: string;
    rootId?: string;
    fileIds?: string[];
    props?: Record<string, unknown>;
  },
): Promise<MattermostPost> {
  const payload: Record<string, unknown> = {
    channel_id: params.channelId,
    message: params.message,
  };
  if (params.rootId) {
    payload.root_id = params.rootId;
  }
  if (params.fileIds?.length) {
    payload.file_ids = params.fileIds;
  }
  if (params.props) {
    payload.props = params.props;
  }
  return await client.request<MattermostPost>("/posts", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

type MattermostTeam = {
  id: string;
  name?: string | null;
  display_name?: string | null;
};

export async function fetchMattermostUserTeams(
  client: MattermostClient,
  userId: string,
): Promise<MattermostTeam[]> {
  return await client.request<MattermostTeam[]>(`/users/${userId}/teams`);
}

export async function updateMattermostPost(
  client: MattermostClient,
  postId: string,
  params: {
    message?: string;
    props?: Record<string, unknown>;
  },
): Promise<MattermostPost> {
  const payload: Record<string, unknown> = { id: postId };
  if (params.message !== undefined) {
    payload.message = params.message;
  }
  if (params.props !== undefined) {
    payload.props = params.props;
  }
  return await client.request<MattermostPost>(`/posts/${postId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deleteMattermostPost(
  client: MattermostClient,
  postId: string,
): Promise<void> {
  await client.request<void>(`/posts/${postId}`, {
    method: "DELETE",
  });
}

export async function uploadMattermostFile(
  client: MattermostClient,
  params: {
    channelId: string;
    buffer: Buffer;
    fileName: string;
    contentType?: string;
  },
): Promise<MattermostFileInfo> {
  const form = new FormData();
  const fileName = normalizeOptionalString(params.fileName) ?? "upload";
  const bytes = Uint8Array.from(params.buffer);
  const blob = params.contentType
    ? new Blob([bytes], { type: params.contentType })
    : new Blob([bytes]);
  form.append("files", blob, fileName);
  form.append("channel_id", params.channelId);

  const res = await client.fetchImpl(`${client.apiBaseUrl}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${client.token}`,
    },
    body: form,
  });

  if (!res.ok) {
    const detail = await readMattermostError(res);
    throw new Error(`Mattermost API ${res.status} ${res.statusText}: ${detail || "unknown error"}`);
  }
  const data = await readProviderJsonResponse<{ file_infos?: MattermostFileInfo[] }>(
    res,
    "Mattermost API /files",
  );
  const info = data.file_infos?.[0];
  if (!info?.id) {
    throw new Error("Mattermost file upload failed");
  }
  return info;
}
