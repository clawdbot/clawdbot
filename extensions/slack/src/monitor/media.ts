import type { WebClient as SlackWebClient } from "@slack/web-api";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeHostname } from "openclaw/plugin-sdk/host-runtime";
import { fetchWithRuntimeDispatcher } from "openclaw/plugin-sdk/infra-runtime";
import type { FetchLike } from "openclaw/plugin-sdk/media-runtime";
import { fetchRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/text-runtime";
import type { SlackAttachment, SlackFile } from "../types.js";

function isSlackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return false;
  }
  // Slack-hosted files typically come from *.slack.com and redirect to Slack CDN domains.
  // Include a small allowlist of known Slack domains to avoid leaking tokens if a file URL
  // is ever spoofed or mishandled.
  const allowedSuffixes = ["slack.com", "slack-edge.com", "slack-files.com"];
  return allowedSuffixes.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

function assertSlackFileUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid Slack file URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing Slack file URL with non-HTTPS protocol: ${parsed.protocol}`);
  }
  if (!isSlackHostname(parsed.hostname)) {
    throw new Error(
      `Refusing to send Slack token to non-Slack host "${parsed.hostname}" (url: ${rawUrl})`,
    );
  }
  return parsed;
}

function createSlackAuthHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

function createSlackMediaRequest(
  url: string,
  token: string,
): {
  url: string;
  requestInit: RequestInit;
} {
  const parsed = assertSlackFileUrl(url);
  return {
    url: parsed.href,
    // Let the shared guarded-fetch redirect logic preserve auth on same-origin
    // Slack hops and strip it once the redirect crosses origins.
    requestInit: { headers: createSlackAuthHeaders(token) },
  };
}

function isMockedFetch(fetchImpl: typeof fetch | undefined): boolean {
  if (typeof fetchImpl !== "function") {
    return false;
  }
  return typeof (fetchImpl as typeof fetch & { mock?: unknown }).mock === "object";
}

function createSlackMediaFetch(): FetchLike {
  return async (input, init) => {
    const url = resolveRequestUrl(input);
    if (!url) {
      throw new Error("Unsupported fetch input: expected string, URL, or Request");
    }
    const parsed = assertSlackFileUrl(url);
    const fetchImpl =
      "dispatcher" in (init ?? {}) && !isMockedFetch(globalThis.fetch)
        ? fetchWithRuntimeDispatcher
        : globalThis.fetch;
    return fetchImpl(parsed.href, { ...init, redirect: "manual" });
  };
}

/**
 * Fetches a URL with Authorization header while keeping same-origin redirects
 * authenticated and dropping auth once the redirect crosses origins.
 */
export async function fetchWithSlackAuth(url: string, token: string): Promise<Response> {
  const parsed = assertSlackFileUrl(url);
  const authHeaders = createSlackAuthHeaders(token);

  const initialRes = await fetch(parsed.href, {
    headers: authHeaders,
    redirect: "manual",
  });

  if (initialRes.status < 300 || initialRes.status >= 400) {
    return initialRes;
  }

  const redirectUrl = initialRes.headers.get("location");
  if (!redirectUrl) {
    return initialRes;
  }

  const resolvedUrl = new URL(redirectUrl, parsed.href);
  if (resolvedUrl.protocol !== "https:") {
    return initialRes;
  }
  if (resolvedUrl.origin === parsed.origin) {
    return fetch(resolvedUrl.toString(), {
      headers: authHeaders,
      redirect: "follow",
    });
  }
  return fetch(resolvedUrl.toString(), { redirect: "follow" });
}

const SLACK_MEDIA_SSRF_POLICY = {
  allowedHostnames: ["*.slack.com", "*.slack-edge.com", "*.slack-files.com"],
  hostnameAllowlist: ["*.slack.com", "*.slack-edge.com", "*.slack-files.com"],
  allowRfc2544BenchmarkRange: true,
};

/**
 * Slack voice messages (audio clips, huddle recordings) carry a `subtype` of
 * `"slack_audio"` but are served with a `video/*` MIME type (e.g. `video/mp4`,
 * `video/webm`).  Override the primary type to `audio/` so the
 * media-understanding pipeline routes them to transcription.
 */
function resolveSlackMediaMimetype(
  file: SlackFile,
  fetchedContentType?: string,
): string | undefined {
  const mime = fetchedContentType ?? file.mimetype;
  if (file.subtype === "slack_audio" && mime?.startsWith("video/")) {
    return mime.replace("video/", "audio/");
  }
  return mime;
}

function looksLikeHtmlBuffer(buffer: Buffer): boolean {
  const head = normalizeLowercaseStringOrEmpty(
    buffer.subarray(0, 512).toString("utf-8").replace(/^\s+/, ""),
  );
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

export type SlackMediaResult = {
  path: string;
  contentType?: string;
  placeholder: string;
};

export const MAX_SLACK_MEDIA_FILES = 8;
const MAX_SLACK_MEDIA_CONCURRENCY = 3;
const MAX_SLACK_FORWARDED_ATTACHMENTS = 8;

function isForwardedSlackAttachment(attachment: SlackAttachment): boolean {
  // Narrow this parser to Slack's explicit "shared/forwarded" attachment payloads.
  return attachment.is_share === true;
}

function resolveForwardedAttachmentImageUrl(attachment: SlackAttachment): string | null {
  const rawUrl = attachment.image_url?.trim();
  if (!rawUrl) {
    return null;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" || !isSlackHostname(parsed.hostname)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results: R[] = [];
  results.length = items.length;
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= items.length) {
          return;
        }
        results[idx] = await fn(items[idx]);
      }
    }),
  );
  return results;
}

/**
 * Downloads all files attached to a Slack message and returns them as an array.
 * Returns `null` when no files could be downloaded.
 */
export async function resolveSlackMedia(params: {
  files?: SlackFile[];
  token: string;
  maxBytes: number;
}): Promise<SlackMediaResult[] | null> {
  const files = params.files ?? [];
  const limitedFiles =
    files.length > MAX_SLACK_MEDIA_FILES ? files.slice(0, MAX_SLACK_MEDIA_FILES) : files;

  const resolved = await mapLimit<SlackFile, SlackMediaResult | null>(
    limitedFiles,
    MAX_SLACK_MEDIA_CONCURRENCY,
    async (file) => {
      const url = file.url_private_download ?? file.url_private;
      if (!url) {
        return null;
      }
      try {
        const { url: slackUrl, requestInit } = createSlackMediaRequest(url, params.token);
        const fetchImpl = createSlackMediaFetch();
        const fetched = await fetchRemoteMedia({
          url: slackUrl,
          fetchImpl,
          requestInit,
          filePathHint: file.name,
          maxBytes: params.maxBytes,
          ssrfPolicy: SLACK_MEDIA_SSRF_POLICY,
        });
        if (fetched.buffer.byteLength > params.maxBytes) {
          return null;
        }

        // Guard against auth/login HTML pages returned instead of binary media.
        // Allow user-provided HTML files through.
        const fileMime = normalizeOptionalLowercaseString(file.mimetype);
        const fileName = normalizeLowercaseStringOrEmpty(file.name);
        const isExpectedHtml =
          fileMime === "text/html" || fileName.endsWith(".html") || fileName.endsWith(".htm");
        if (!isExpectedHtml) {
          const detectedMime = normalizeOptionalLowercaseString(fetched.contentType?.split(";")[0]);
          if (detectedMime === "text/html" || looksLikeHtmlBuffer(fetched.buffer)) {
            return null;
          }
        }

        const effectiveMime = resolveSlackMediaMimetype(file, fetched.contentType);
        const saved = await saveMediaBuffer(
          fetched.buffer,
          effectiveMime,
          "inbound",
          params.maxBytes,
        );
        const label = fetched.fileName ?? file.name;
        const contentType = effectiveMime ?? saved.contentType;
        return {
          path: saved.path,
          ...(contentType ? { contentType } : {}),
          placeholder: label ? `[Slack file: ${label}]` : "[Slack file]",
        };
      } catch {
        return null;
      }
    },
  );

  const results = resolved.filter((entry): entry is SlackMediaResult => Boolean(entry));
  return results.length > 0 ? results : null;
}

/** Extracts text and media from forwarded-message attachments. Returns null when empty. */
export async function resolveSlackAttachmentContent(params: {
  attachments?: SlackAttachment[];
  token: string;
  maxBytes: number;
}): Promise<{ text: string; media: SlackMediaResult[] } | null> {
  const attachments = params.attachments;
  if (!attachments || attachments.length === 0) {
    return null;
  }

  const forwardedAttachments = attachments
    .filter((attachment) => isForwardedSlackAttachment(attachment))
    .slice(0, MAX_SLACK_FORWARDED_ATTACHMENTS);
  if (forwardedAttachments.length === 0) {
    return null;
  }

  const textBlocks: string[] = [];
  const allMedia: SlackMediaResult[] = [];

  for (const att of forwardedAttachments) {
    const text = att.text?.trim() || att.fallback?.trim();
    if (text) {
      const author = att.author_name;
      const heading = author ? `[Forwarded message from ${author}]` : "[Forwarded message]";
      textBlocks.push(`${heading}\n${text}`);
    }

    const imageUrl = resolveForwardedAttachmentImageUrl(att);
    if (imageUrl) {
      try {
        const { url: slackUrl, requestInit } = createSlackMediaRequest(imageUrl, params.token);
        const fetchImpl = createSlackMediaFetch();
        const fetched = await fetchRemoteMedia({
          url: slackUrl,
          fetchImpl,
          requestInit,
          maxBytes: params.maxBytes,
          ssrfPolicy: SLACK_MEDIA_SSRF_POLICY,
        });
        if (fetched.buffer.byteLength <= params.maxBytes) {
          const saved = await saveMediaBuffer(
            fetched.buffer,
            fetched.contentType,
            "inbound",
            params.maxBytes,
          );
          const label = fetched.fileName ?? "forwarded image";
          allMedia.push({
            path: saved.path,
            contentType: fetched.contentType ?? saved.contentType,
            placeholder: `[Forwarded image: ${label}]`,
          });
        }
      } catch {
        // Skip images that fail to download
      }
    }

    if (att.files && att.files.length > 0) {
      const fileMedia = await resolveSlackMedia({
        files: att.files,
        token: params.token,
        maxBytes: params.maxBytes,
      });
      if (fileMedia) {
        allMedia.push(...fileMedia);
      }
    }
  }

  const combinedText = textBlocks.join("\n\n");
  if (!combinedText && allMedia.length === 0) {
    return null;
  }
  return { text: combinedText, media: allMedia };
}

export type SlackThreadStarter = {
  text: string;
  userId?: string;
  botId?: string;
  ts?: string;
  files?: SlackFile[];
};

type SlackThreadStarterCacheEntry = {
  value: SlackThreadStarter;
  cachedAt: number;
};

const THREAD_STARTER_CACHE = new Map<string, SlackThreadStarterCacheEntry>();
const THREAD_STARTER_CACHE_TTL_MS = 6 * 60 * 60_000;
const THREAD_STARTER_CACHE_MAX = 2000;

function evictThreadStarterCache(): void {
  const now = Date.now();
  for (const [cacheKey, entry] of THREAD_STARTER_CACHE.entries()) {
    if (now - entry.cachedAt > THREAD_STARTER_CACHE_TTL_MS) {
      THREAD_STARTER_CACHE.delete(cacheKey);
    }
  }
  pruneMapToMaxSize(THREAD_STARTER_CACHE, THREAD_STARTER_CACHE_MAX);
}

function formatSlackFilePlaceholder(files: SlackFile[] | undefined): string {
  return `[attached: ${files?.map((file) => file.name ?? "file").join(", ") ?? "file"}]`;
}

export async function resolveSlackThreadStarter(params: {
  channelId: string;
  threadTs: string;
  client: SlackWebClient;
}): Promise<SlackThreadStarter | null> {
  evictThreadStarterCache();
  const cacheKey = `${params.channelId}:${params.threadTs}`;
  const cached = THREAD_STARTER_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt <= THREAD_STARTER_CACHE_TTL_MS) {
    return cached.value;
  }
  if (cached) {
    THREAD_STARTER_CACHE.delete(cacheKey);
  }
  try {
    const response = (await params.client.conversations.replies({
      channel: params.channelId,
      ts: params.threadTs,
      limit: 1,
      inclusive: true,
    })) as {
      messages?: Array<{
        text?: string;
        user?: string;
        bot_id?: string;
        ts?: string;
        files?: SlackFile[];
      }>;
    };
    const message = response?.messages?.[0];
    const text = (message?.text ?? "").trim();
    const files = message?.files?.length ? message.files : undefined;
    if (!message || (!text && !files)) {
      return null;
    }
    const starter: SlackThreadStarter = {
      text: text || formatSlackFilePlaceholder(files),
      userId: message.user,
      botId: message.bot_id,
      ts: message.ts,
      files,
    };
    if (THREAD_STARTER_CACHE.has(cacheKey)) {
      THREAD_STARTER_CACHE.delete(cacheKey);
    }
    THREAD_STARTER_CACHE.set(cacheKey, {
      value: starter,
      cachedAt: Date.now(),
    });
    evictThreadStarterCache();
    return starter;
  } catch (err) {
    logVerbose(
      `slack thread starter fetch failed channel=${params.channelId} ts=${params.threadTs}: ${formatErrorMessage(err)}`,
    );
    return null;
  }
}

export function resetSlackThreadStarterCacheForTest(): void {
  THREAD_STARTER_CACHE.clear();
}

export type SlackThreadMessage = {
  text: string;
  userId?: string;
  ts?: string;
  botId?: string;
  files?: SlackFile[];
};

type SlackRepliesPageMessage = {
  text?: string;
  user?: string;
  bot_id?: string;
  ts?: string;
  files?: SlackFile[];
};

type SlackRepliesPage = {
  messages?: SlackRepliesPageMessage[];
  response_metadata?: { next_cursor?: string };
};

/**
 * Fetches the most recent messages in a Slack thread (excluding the current message).
 * Used to populate thread context when a new thread session starts.
 *
 * Uses cursor pagination and keeps only the latest N retained messages so long threads
 * still produce up-to-date context without unbounded memory growth.
 */
export async function resolveSlackThreadHistory(params: {
  channelId: string;
  threadTs: string;
  client: SlackWebClient;
  currentMessageTs?: string;
  limit?: number;
}): Promise<SlackThreadMessage[]> {
  const maxMessages = params.limit ?? 20;
  if (!Number.isFinite(maxMessages) || maxMessages <= 0) {
    return [];
  }

  // Slack recommends no more than 200 per page.
  const fetchLimit = 200;
  const retained: SlackRepliesPageMessage[] = [];
  let cursor: string | undefined;

  try {
    do {
      const response = (await params.client.conversations.replies({
        channel: params.channelId,
        ts: params.threadTs,
        limit: fetchLimit,
        inclusive: true,
        ...(cursor ? { cursor } : {}),
      })) as SlackRepliesPage;

      for (const msg of response.messages ?? []) {
        // Keep messages with text OR file attachments
        if (!msg.text?.trim() && !msg.files?.length) {
          continue;
        }
        if (params.currentMessageTs && msg.ts === params.currentMessageTs) {
          continue;
        }
        retained.push(msg);
        if (retained.length > maxMessages) {
          retained.shift();
        }
      }

      const next = response.response_metadata?.next_cursor;
      cursor = typeof next === "string" && next.trim().length > 0 ? next.trim() : undefined;
    } while (cursor);

    return retained.map((msg) => ({
      // For file-only messages, create a placeholder showing attached filenames
      text: msg.text?.trim() ? msg.text : formatSlackFilePlaceholder(msg.files),
      userId: msg.user,
      botId: msg.bot_id,
      ts: msg.ts,
      files: msg.files,
    }));
  } catch (err) {
    logVerbose(
      `slack thread history fetch failed channel=${params.channelId} ts=${params.threadTs}: ${formatErrorMessage(err)}`,
    );
    return [];
  }
}
