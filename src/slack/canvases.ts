import type { WebClient as SlackWebClient } from "@slack/web-api";

import { logVerbose } from "../globals.js";
import type { SlackFile, SlackMessageEvent } from "./types.js";

type CanvasUrlMatch = {
  url: string;
  fileId?: string;
};

export type SlackCanvasRef = {
  fileId?: string;
  canvasUrl?: string;
  channelId?: string;
  messageTs?: string;
};

export type SlackCanvasContent = {
  title?: string;
  extractedText: string;
  rawFormat: "json" | "text" | "unknown";
  truncated: boolean;
};

export type SlackCanvasFetchResult =
  | ({ ok: true } & SlackCanvasContent)
  | { ok: false; error: string };

const SLACK_CANVAS_MIME = "application/vnd.slack-docs";
const CANVAS_FILETYPE_HINTS = new Set(["quip"]);
const CANVAS_PRETTY_TYPE = new Set(["canvas"]);

const CANVAS_URL_RE = /https?:\/\/[^\s<>"]*slack\.com\/(docs|canvas|doc|files)\/[^\s<>"]+/gi;
const SLACK_FILE_ID_RE = /\bF[A-Z0-9]{8,}\b/g;

export function isSlackCanvasFile(file?: SlackFile | null): boolean {
  if (!file) return false;
  const mimetype = file.mimetype?.toLowerCase();
  const prettyType = file.pretty_type?.toLowerCase();
  const filetype = file.filetype?.toLowerCase();
  if (mimetype && mimetype === SLACK_CANVAS_MIME) return true;
  if (prettyType && CANVAS_PRETTY_TYPE.has(prettyType)) return true;
  if (filetype && CANVAS_FILETYPE_HINTS.has(filetype)) return true;
  return false;
}

function extractFileIdFromUrl(url: string): string | undefined {
  const matches = url.match(SLACK_FILE_ID_RE);
  if (!matches || matches.length === 0) return undefined;
  return matches[0];
}

function collectUrlsFromText(text: string): CanvasUrlMatch[] {
  const matches = text.match(CANVAS_URL_RE) ?? [];
  return matches.map((url) => ({ url, fileId: extractFileIdFromUrl(url) }));
}

function collectUrlsFromObject(value: unknown, into: CanvasUrlMatch[], seen = new Set<string>()) {
  if (!value) return;
  if (typeof value === "string") {
    for (const entry of collectUrlsFromText(value)) {
      if (seen.has(entry.url)) continue;
      seen.add(entry.url);
      into.push(entry);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectUrlsFromObject(entry, into, seen);
    return;
  }
  if (typeof value !== "object") return;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    collectUrlsFromObject(entry, into, seen);
  }
}

export function extractCanvasRefsFromEvent(event: SlackMessageEvent): SlackCanvasRef[] {
  const refs: SlackCanvasRef[] = [];
  const seen = new Set<string>();
  const channelId = event.channel;
  const messageTs = event.ts ?? event.event_ts;

  for (const file of event.files ?? []) {
    if (!isSlackCanvasFile(file)) continue;
    const fileId = file.id;
    if (fileId && seen.has(fileId)) continue;
    if (fileId) seen.add(fileId);
    refs.push({ fileId, channelId, messageTs });
  }

  const urlMatches: CanvasUrlMatch[] = [];
  if (event.text) collectUrlsFromObject(event.text, urlMatches);
  collectUrlsFromObject(event.blocks, urlMatches);
  collectUrlsFromObject(event.attachments, urlMatches);

  for (const match of urlMatches) {
    const dedupeKey = match.fileId ?? match.url;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    refs.push({
      fileId: match.fileId,
      canvasUrl: match.url,
      channelId,
      messageTs,
    });
  }

  return refs;
}

function buildErrorLabel(err: unknown): string {
  const data = err as { data?: { error?: string; needed?: string | string[] } } | undefined;
  const apiError = data?.data?.error ?? (err as { error?: string } | undefined)?.error;
  if (apiError === "missing_scope") {
    const needed = data?.data?.needed;
    const scopeList = Array.isArray(needed) ? needed.join(", ") : needed;
    return scopeList ? `missing_scope: ${scopeList}` : "missing_scope";
  }
  if (apiError === "not_allowed_token_type") return "not_allowed_token_type";
  if (apiError === "not_in_channel") return "not_in_channel";
  if (apiError === "channel_not_found") return "channel_not_found";
  if (apiError && typeof apiError === "string") return apiError;
  return err instanceof Error ? err.message : String(err);
}

function coerceToText(input: string, maxChars: number): { text: string; truncated: boolean } {
  if (input.length <= maxChars) return { text: input, truncated: false };
  return { text: input.slice(0, maxChars), truncated: true };
}

function collectJsonText(
  value: unknown,
  params: {
    maxChars: number;
    results: string[];
    seen: Set<string>;
    depth: number;
  },
) {
  if (params.results.join("\n").length >= params.maxChars) return;
  if (params.depth > 12) return;
  if (value == null) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!params.seen.has(trimmed)) {
      params.seen.add(trimmed);
      params.results.push(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectJsonText(entry, { ...params, depth: params.depth + 1 });
      if (params.results.join("\n").length >= params.maxChars) return;
    }
    return;
  }
  if (typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const preferredKeys = ["text", "plain_text", "title", "value", "name"];
  for (const key of preferredKeys) {
    const entry = record[key];
    if (typeof entry === "string") {
      collectJsonText(entry, { ...params, depth: params.depth + 1 });
    }
  }
  for (const entry of Object.values(record)) {
    collectJsonText(entry, { ...params, depth: params.depth + 1 });
    if (params.results.join("\n").length >= params.maxChars) return;
  }
}

function extractTextFromJson(
  payload: unknown,
  maxChars: number,
): { text: string; truncated: boolean } {
  const results: string[] = [];
  const seen = new Set<string>();
  collectJsonText(payload, { maxChars, results, seen, depth: 0 });
  const joined = results.join("\n");
  if (!joined) {
    return coerceToText(JSON.stringify(payload), maxChars);
  }
  return coerceToText(joined, maxChars);
}

export async function fetchSlackCanvasContent(params: {
  ref: SlackCanvasRef;
  client: SlackWebClient;
  token: string;
  maxBytes: number;
  maxChars: number;
}): Promise<SlackCanvasFetchResult> {
  const { ref, client, token, maxBytes, maxChars } = params;
  const fileId = ref.fileId ?? (ref.canvasUrl ? extractFileIdFromUrl(ref.canvasUrl) : undefined);
  if (!fileId) {
    return { ok: false, error: "no_file_id" };
  }

  let fileInfo: {
    file?: SlackFile & {
      title?: string;
      name?: string;
      url_private?: string;
      url_private_download?: string;
    };
  };
  try {
    fileInfo = (await client.files.info({ file: fileId })) as {
      file?: SlackFile & {
        title?: string;
        name?: string;
        url_private?: string;
        url_private_download?: string;
      };
    };
  } catch (err) {
    const label = buildErrorLabel(err);
    logVerbose(`slack canvases: files.info failed fileId=${fileId} error=${label}`);
    return { ok: false, error: label };
  }

  const file = fileInfo.file;
  if (!file) {
    return { ok: false, error: "file_not_found" };
  }

  const url = file.url_private_download ?? file.url_private;
  if (!url) {
    return { ok: false, error: "missing_download_url" };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    return { ok: false, error: `download_failed: ${String(err)}` };
  }

  if (!response.ok) {
    return { ok: false, error: `download_http_${response.status}` };
  }

  const contentType = response.headers.get("content-type") ?? "";
  const buffer = await response.arrayBuffer();
  const truncatedByBytes = buffer.byteLength > maxBytes;
  const sliced = truncatedByBytes ? buffer.slice(0, maxBytes) : buffer;
  const text = new TextDecoder().decode(sliced);

  let extracted: { text: string; truncated: boolean };
  let rawFormat: SlackCanvasContent["rawFormat"] = "unknown";

  if (
    contentType.includes("application/json") ||
    text.trim().startsWith("{") ||
    text.trim().startsWith("[")
  ) {
    rawFormat = "json";
    try {
      const payload = JSON.parse(text);
      extracted = extractTextFromJson(payload, maxChars);
    } catch {
      extracted = coerceToText(text, maxChars);
    }
  } else {
    rawFormat = "text";
    extracted = coerceToText(text, maxChars);
  }

  return {
    ok: true,
    title: file.title ?? file.name ?? fileId,
    extractedText: extracted.text,
    rawFormat,
    truncated: truncatedByBytes || extracted.truncated,
  };
}
