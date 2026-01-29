import type { WebClient as SlackWebClient } from "@slack/web-api";

import type { FetchLike } from "../../media/fetch.js";
import { fetchRemoteMedia } from "../../media/fetch.js";
import { saveMediaBuffer } from "../../media/store.js";
import type { SlackFile } from "../types.js";

/**
 * Fetches a URL with Authorization header, handling cross-origin redirects.
 * Node.js fetch strips Authorization headers on cross-origin redirects for security.
 * Slack's files.slack.com URLs redirect to CDN domains with pre-signed URLs that
 * don't need the Authorization header, so we handle the initial auth request manually.
 */
export async function fetchWithSlackAuth(url: string, token: string): Promise<Response> {
  // Initial request with auth and manual redirect handling
  const initialRes = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "manual",
  });

  // If not a redirect, return the response directly
  if (initialRes.status < 300 || initialRes.status >= 400) {
    return initialRes;
  }

  // Handle redirect - the redirected URL should be pre-signed and not need auth
  const redirectUrl = initialRes.headers.get("location");
  if (!redirectUrl) {
    return initialRes;
  }

  // Resolve relative URLs against the original
  const resolvedUrl = new URL(redirectUrl, url).toString();

  // Follow the redirect without the Authorization header
  // (Slack's CDN URLs are pre-signed and don't need it)
  return fetch(resolvedUrl, { redirect: "follow" });
}

export type SlackMediaInfo = {
  path: string;
  contentType?: string;
  placeholder: string;
};

/**
 * Resolves all Slack media files from a message.
 * Returns an array of successfully downloaded files.
 */
export async function resolveSlackMediaList(params: {
  files?: SlackFile[];
  token: string;
  maxBytes: number;
}): Promise<SlackMediaInfo[]> {
  const files = params.files ?? [];
  const out: SlackMediaInfo[] = [];
  for (const file of files) {
    const url = file.url_private_download ?? file.url_private;
    if (!url) continue;
    try {
      // Note: We ignore init options because fetchWithSlackAuth handles
      // redirect behavior specially. fetchRemoteMedia only passes the URL.
      const fetchImpl: FetchLike = (input) => {
        const inputUrl =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return fetchWithSlackAuth(inputUrl, params.token);
      };
      const fetched = await fetchRemoteMedia({
        url,
        fetchImpl,
        filePathHint: file.name,
      });
      if (fetched.buffer.byteLength > params.maxBytes) continue;
      const saved = await saveMediaBuffer(
        fetched.buffer,
        fetched.contentType ?? file.mimetype,
        "inbound",
        params.maxBytes,
      );
      const label = fetched.fileName ?? file.name;
      out.push({
        path: saved.path,
        contentType: saved.contentType,
        placeholder: label ? `[Slack file: ${label}]` : "[Slack file]",
      });
    } catch {
      // Ignore download failures and continue to the next file.
    }
  }
  return out;
}

/**
 * Legacy function for backwards compatibility.
 * @deprecated Use resolveSlackMediaList instead.
 */
export async function resolveSlackMedia(params: {
  files?: SlackFile[];
  token: string;
  maxBytes: number;
}): Promise<SlackMediaInfo | null> {
  const list = await resolveSlackMediaList(params);
  return list[0] ?? null;
}

/**
 * Builds the media payload fields for the inbound context.
 * Provides both singular (MediaPath) and plural (MediaPaths) fields for compatibility.
 */
export function buildSlackMediaPayload(mediaList: SlackMediaInfo[]): {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
  placeholder?: string;
} {
  if (mediaList.length === 0) return {};
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const mediaTypes = mediaList.map((media) => media.contentType).filter(Boolean) as string[];
  const placeholders = mediaList.map((media) => media.placeholder);
  return {
    MediaPath: first?.path,
    MediaType: first?.contentType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
    placeholder: placeholders.length > 0 ? placeholders.join(" ") : undefined,
  };
}

export type SlackThreadStarter = {
  text: string;
  userId?: string;
  ts?: string;
  files?: SlackFile[];
};

const THREAD_STARTER_CACHE = new Map<string, SlackThreadStarter>();

export async function resolveSlackThreadStarter(params: {
  channelId: string;
  threadTs: string;
  client: SlackWebClient;
}): Promise<SlackThreadStarter | null> {
  const cacheKey = `${params.channelId}:${params.threadTs}`;
  const cached = THREAD_STARTER_CACHE.get(cacheKey);
  if (cached) return cached;
  try {
    const response = (await params.client.conversations.replies({
      channel: params.channelId,
      ts: params.threadTs,
      limit: 1,
      inclusive: true,
    })) as { messages?: Array<{ text?: string; user?: string; ts?: string; files?: SlackFile[] }> };
    const message = response?.messages?.[0];
    const text = (message?.text ?? "").trim();
    if (!message || !text) return null;
    const starter: SlackThreadStarter = {
      text,
      userId: message.user,
      ts: message.ts,
      files: message.files,
    };
    THREAD_STARTER_CACHE.set(cacheKey, starter);
    return starter;
  } catch {
    return null;
  }
}
