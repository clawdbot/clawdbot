// Slack plugin module implements media behavior.
import fs from "node:fs/promises";
import type { WebClient as SlackWebClient } from "@slack/web-api";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeHostname } from "openclaw/plugin-sdk/host-runtime";
import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatSlackFileReference } from "../file-reference.js";
import type { SlackAttachment, SlackFile } from "../types.js";
import { MAX_SLACK_MEDIA_FILES, type SlackMediaResult } from "./media-types.js";
import {
  type FetchLike,
  fetchWithRuntimeDispatcher,
  saveRemoteMedia,
  slackMediaLog,
} from "./media.runtime.js";
import { isGovSlackClient } from "./slack-client-kind.js";
import { logVerbose } from "./thread.runtime.js";
export type { SlackMediaResult } from "./media-types.js";

function isSlackHostname(hostname: string, govSlack: boolean): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return false;
  }
  // GovSlack is a separate compliance plane; its token must never follow
  // commercial Slack/CDN URLs or undocumented government subdomains.
  if (govSlack) {
    return normalized === "files.slack-gov.com";
  }
  // Slack-hosted files typically come from *.slack.com and redirect to Slack CDN domains.
  // Include a small allowlist of known Slack domains to avoid leaking tokens if a file URL
  // is ever spoofed or mishandled.
  const allowedSuffixes = ["slack.com", "slack-edge.com", "slack-files.com"];
  return allowedSuffixes.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

function assertSlackFileUrl(rawUrl: string, govSlack: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid Slack file URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing Slack file URL with non-HTTPS protocol: ${parsed.protocol}`);
  }
  if (!isSlackHostname(parsed.hostname, govSlack)) {
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
  govSlack: boolean,
): {
  url: string;
  requestInit: RequestInit;
} {
  const parsed = assertSlackFileUrl(url, govSlack);
  return {
    url: parsed.href,
    // Let the shared guarded-fetch redirect logic preserve auth on same-origin
    // Slack hops and strip it once the redirect crosses origins.
    requestInit: { headers: createSlackAuthHeaders(token) },
  };
}

function createSlackMediaFetch(govSlack: boolean): FetchLike {
  return async (input, init) => {
    const url = resolveRequestUrl(input);
    if (!url) {
      throw new Error("Unsupported fetch input: expected string, URL, or Request");
    }
    const parsed = assertSlackFileUrl(url, govSlack);
    const fetchImpl = "dispatcher" in (init ?? {}) ? fetchWithRuntimeDispatcher : globalThis.fetch;
    return fetchImpl(parsed.href, { ...init, redirect: "manual" });
  };
}

const SLACK_MEDIA_SSRF_POLICY = {
  allowedHostnames: ["*.slack.com", "*.slack-edge.com", "*.slack-files.com"],
  hostnameAllowlist: ["*.slack.com", "*.slack-edge.com", "*.slack-files.com"],
  allowRfc2544BenchmarkRange: true,
};
const SLACK_GOV_MEDIA_SSRF_POLICY = {
  hostnameAllowlist: ["files.slack-gov.com"],
  allowRfc2544BenchmarkRange: true,
};
export const SLACK_MEDIA_READ_IDLE_TIMEOUT_MS = 60_000;
const SLACK_MEDIA_TOTAL_TIMEOUT_MS = 120_000;
type SlackSaveRemoteMediaOptions = Parameters<typeof saveRemoteMedia>[0];

async function saveSlackMedia(params: {
  options: SlackSaveRemoteMediaOptions;
  readIdleTimeoutMs?: number;
  totalTimeoutMs?: number;
  abortSignal?: AbortSignal;
}): ReturnType<typeof saveRemoteMedia> {
  const timeoutAbortController = params.totalTimeoutMs ? new AbortController() : undefined;
  const abortSignals = [
    params.abortSignal,
    params.options.requestInit?.signal ?? undefined,
    timeoutAbortController?.signal,
  ].filter((signal): signal is AbortSignal => Boolean(signal));
  const signal = abortSignals.length > 1 ? AbortSignal.any(abortSignals) : abortSignals[0];
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const savePromise = saveRemoteMedia({
    ...params.options,
    readIdleTimeoutMs: params.readIdleTimeoutMs ?? SLACK_MEDIA_READ_IDLE_TIMEOUT_MS,
    ...(signal
      ? {
          requestInit: {
            ...params.options.requestInit,
            signal,
          },
        }
      : {}),
  }).catch((error: unknown) => {
    if (timedOut) {
      return new Promise<never>(() => {});
    }
    throw error;
  });

  try {
    if (!params.totalTimeoutMs) {
      return await savePromise;
    }
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        timeoutAbortController?.abort();
        reject(new Error(`slack media download timed out after ${params.totalTimeoutMs}ms`));
      }, params.totalTimeoutMs);
      timeoutHandle.unref?.();
    });
    return await Promise.race([savePromise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

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

async function looksLikeHtmlFile(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, "r").catch(() => null);
  if (!handle) {
    return false;
  }
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return looksLikeHtmlBuffer(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const MAX_SLACK_MEDIA_CONCURRENCY = 3;
const MAX_SLACK_FORWARDED_ATTACHMENTS = 8;
const SLACK_MEDIA_LIMIT_REASON = `omitted: ${MAX_SLACK_MEDIA_FILES}-file limit`;

function formatSlackMediaFailure(error: unknown): string {
  // Download errors can contain URLs and response bodies; redact before bounding
  // the text shared by diagnostics and model context, even with log redaction off.
  return redactToolPayloadText(formatErrorMessage(error)).replace(/\s+/g, " ").slice(0, 200);
}

async function fetchFreshSlackFileUrl(params: {
  file: SlackFile;
  client?: SlackWebClient;
  isRefreshedFileAllowed?: (file: SlackFile) => boolean;
}): Promise<string | null> {
  if (!params.file.id || !params.client) {
    return null;
  }
  try {
    const info = await params.client.files.info({ file: params.file.id });
    const freshFile = info.file as SlackFile | undefined;
    if (freshFile && params.isRefreshedFileAllowed?.(freshFile) === false) {
      logVerbose(`slack: refreshed file metadata rejected for file id=${params.file.id}`);
      return null;
    }
    const freshUrl = freshFile?.url_private_download ?? freshFile?.url_private;
    if (freshUrl) {
      logVerbose(`slack: refreshed file URL via files.info for file id=${params.file.id}`);
      return freshUrl;
    }
    logVerbose(`slack: files.info returned no private URL for file id=${params.file.id}`);
    return null;
  } catch (error) {
    logVerbose(
      `slack: files.info failed for file id=${params.file.id}: ${formatErrorMessage(error)}`,
    );
    return null;
  }
}

async function downloadSlackMediaFile(params: {
  file: SlackFile;
  url: string;
  token: string;
  maxBytes: number;
  readIdleTimeoutMs?: number;
  totalTimeoutMs?: number;
  abortSignal?: AbortSignal;
  govSlack: boolean;
}): Promise<SlackMediaResult> {
  const { url: slackUrl, requestInit } = createSlackMediaRequest(
    params.url,
    params.token,
    params.govSlack,
  );
  const fetchImpl = createSlackMediaFetch(params.govSlack);
  const saved = await saveSlackMedia({
    options: {
      url: slackUrl,
      fetchImpl,
      requestInit,
      filePathHint: params.file.name,
      fallbackContentType: resolveSlackMediaMimetype(params.file, params.file.mimetype),
      maxBytes: params.maxBytes,
      ssrfPolicy: params.govSlack ? SLACK_GOV_MEDIA_SSRF_POLICY : SLACK_MEDIA_SSRF_POLICY,
    },
    readIdleTimeoutMs: params.readIdleTimeoutMs,
    totalTimeoutMs: params.totalTimeoutMs ?? SLACK_MEDIA_TOTAL_TIMEOUT_MS,
    abortSignal: params.abortSignal,
  });

  // Guard against auth/login HTML pages returned instead of binary media.
  // Allow user-provided HTML files through.
  const fileMime = normalizeOptionalLowercaseString(params.file.mimetype);
  const fileName = normalizeLowercaseStringOrEmpty(params.file.name);
  const isExpectedHtml =
    fileMime === "text/html" || fileName.endsWith(".html") || fileName.endsWith(".htm");
  if (!isExpectedHtml) {
    const detectedMime = normalizeOptionalLowercaseString(saved.contentType?.split(";")[0]);
    if (detectedMime === "text/html" || (await looksLikeHtmlFile(saved.path))) {
      await fs.rm(saved.path, { force: true }).catch(() => undefined);
      throw new Error("blocked: unexpected HTML content");
    }
  }

  const effectiveMime = resolveSlackMediaMimetype(params.file, saved.contentType);
  const label = saved.fileName ?? params.file.name;
  const contentType = effectiveMime ?? saved.contentType;
  return {
    path: saved.path,
    ...(contentType ? { contentType } : {}),
    ...(label ? { fileName: label } : {}),
    placeholder: `[Slack file: ${formatSlackFileReference({ ...params.file, name: label })}]`,
  };
}

function isForwardedSlackAttachment(attachment: SlackAttachment): boolean {
  // Narrow this parser to Slack's explicit "shared/forwarded" attachment payloads.
  return attachment.is_share === true;
}

function resolveForwardedAttachmentImageUrl(
  attachment: SlackAttachment,
  govSlack: boolean,
): string | null {
  const rawUrl = attachment.image_url?.trim();
  if (!rawUrl) {
    return null;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" || !isSlackHostname(parsed.hostname, govSlack)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Downloads all files attached to a Slack message and returns them as an array.
 * Returns `null` when no files could be downloaded.
 */
export async function resolveSlackMedia(params: {
  files?: SlackFile[];
  client?: SlackWebClient;
  isRefreshedFileAllowed?: (file: SlackFile) => boolean;
  token: string;
  maxBytes: number;
  readIdleTimeoutMs?: number;
  totalTimeoutMs?: number;
  abortSignal?: AbortSignal;
  preloadedMedia?: ReadonlyMap<SlackFile, SlackMediaResult>;
  unavailableFiles?: Map<SlackFile, string>;
}): Promise<SlackMediaResult[] | null> {
  const govSlack = isGovSlackClient(params.client);
  const files = params.files ?? [];
  const limitedFiles =
    files.length > MAX_SLACK_MEDIA_FILES ? files.slice(0, MAX_SLACK_MEDIA_FILES) : files;
  for (const file of files.slice(MAX_SLACK_MEDIA_FILES)) {
    params.unavailableFiles?.set(file, SLACK_MEDIA_LIMIT_REASON);
  }
  const refreshFileUrl = (file: SlackFile) =>
    fetchFreshSlackFileUrl({
      file,
      client: params.client,
      isRefreshedFileAllowed: params.isRefreshedFileAllowed,
    });

  const { results } = await runTasksWithConcurrency({
    tasks: limitedFiles.map((file) => async (): Promise<SlackMediaResult | null> => {
      // Audio preflight keys the original event file object so admission can
      // reuse that exact download without turning this into a persistent cache.
      const preloaded = params.preloadedMedia?.get(file);
      if (preloaded) {
        return preloaded;
      }
      const eventUrl = file.url_private_download ?? file.url_private;
      let url = eventUrl ?? (await refreshFileUrl(file));
      let reason = "no private download URL";
      for (let attempt = 0; url && attempt < 2; attempt += 1) {
        try {
          return await downloadSlackMediaFile({ ...params, file, url, govSlack });
        } catch (error) {
          reason = formatSlackMediaFailure(error);
        }
        // Only a failed event URL gets the existing files.info retry. Record
        // the final outcome once so a recovered download is not called unavailable.
        url = attempt === 0 && eventUrl ? await refreshFileUrl(file) : null;
      }
      params.unavailableFiles?.set(file, reason);
      slackMediaLog.warn(`slack: file ${formatSlackFileReference(file)} unavailable (${reason})`);
      return null;
    }),
    limit: MAX_SLACK_MEDIA_CONCURRENCY,
    errorMode: "stop",
    throwOnError: true,
  });
  const resolved = results.filter((result): result is SlackMediaResult => result !== null);

  return resolved.length > 0 ? resolved : null;
}

/** Extracts text and media from forwarded-message attachments. Returns null when empty. */
export async function resolveSlackAttachmentContent(params: {
  files?: SlackFile[];
  attachments?: SlackAttachment[];
  client?: SlackWebClient;
  token: string;
  maxBytes: number;
  readIdleTimeoutMs?: number;
  totalTimeoutMs?: number;
  abortSignal?: AbortSignal;
  preloadedMedia?: ReadonlyMap<SlackFile, SlackMediaResult>;
}): Promise<{
  text: string;
  media: SlackMediaResult[];
  files?: (SlackFile & { reason: string })[];
  unavailableMediaCount: number;
} | null> {
  const forwardedAttachments = (params.attachments ?? [])
    .filter((attachment) => isForwardedSlackAttachment(attachment))
    .slice(0, MAX_SLACK_FORWARDED_ATTACHMENTS);
  const candidates = [
    ...(params.files ?? []),
    ...forwardedAttachments.flatMap((attachment) => attachment.files ?? []),
  ];
  if (forwardedAttachments.length === 0 && candidates.length === 0) {
    return null;
  }

  const fileIds = new Set<string>();
  const allFiles = candidates
    .filter((file) => {
      const fileId = normalizeOptionalString(file.id);
      if (!fileId) {
        return true;
      }
      if (fileIds.has(fileId)) {
        return false;
      }
      fileIds.add(fileId);
      return true;
    })
    .map((file, index) => {
      if (index >= MAX_SLACK_MEDIA_FILES) {
        return file;
      }
      const fileId = normalizeOptionalString(file.id);
      const preloaded =
        fileId &&
        candidates.find(
          (candidate) =>
            normalizeOptionalString(candidate.id) === fileId &&
            params.preloadedMedia?.has(candidate),
        );
      if (preloaded) {
        return preloaded;
      }
      if (!fileId || file.url_private_download || file.url_private) {
        return file;
      }
      const downloadable = candidates.find(
        (candidate) =>
          normalizeOptionalString(candidate.id) === fileId &&
          (candidate.url_private_download || candidate.url_private),
      );
      return downloadable ? Object.assign({}, file, downloadable) : file;
    });
  const pendingFiles = new Map<SlackFile | string, SlackFile>(
    allFiles
      .slice(0, MAX_SLACK_MEDIA_FILES)
      .map((file) => [normalizeOptionalString(file.id) ?? file, file]),
  );
  const unavailableFileReasons = new Map<SlackFile, string>();
  const resolveFiles = (files?: SlackFile[]) =>
    resolveSlackMedia({
      ...params,
      unavailableFiles: unavailableFileReasons,
      files: files?.flatMap((file) => {
        const key = normalizeOptionalString(file.id) ?? file;
        const selected = pendingFiles.get(key);
        pendingFiles.delete(key);
        return selected ? [selected] : [];
      }),
    });
  const directMediaPromise = resolveFiles(params.files);
  const textBlocks: string[] = [];
  const attachmentMedia: SlackMediaResult[] = [];
  let unavailableMediaCount = 0;
  const govSlack = isGovSlackClient(params.client);

  for (const att of forwardedAttachments) {
    const text = att.text?.trim() || att.fallback?.trim();
    if (text) {
      const author = att.author_name;
      const heading = author ? `[Forwarded message from ${author}]` : "[Forwarded message]";
      textBlocks.push(`${heading}\n${text}`);
    }

    const imageUrl = resolveForwardedAttachmentImageUrl(att, govSlack);
    if (imageUrl) {
      try {
        const { url: slackUrl, requestInit } = createSlackMediaRequest(
          imageUrl,
          params.token,
          govSlack,
        );
        const fetchImpl = createSlackMediaFetch(govSlack);
        const saved = await saveSlackMedia({
          options: {
            url: slackUrl,
            fetchImpl,
            requestInit,
            maxBytes: params.maxBytes,
            ssrfPolicy: govSlack ? SLACK_GOV_MEDIA_SSRF_POLICY : SLACK_MEDIA_SSRF_POLICY,
          },
          readIdleTimeoutMs: params.readIdleTimeoutMs,
          totalTimeoutMs: params.totalTimeoutMs ?? SLACK_MEDIA_TOTAL_TIMEOUT_MS,
          abortSignal: params.abortSignal,
        });
        const label = saved.fileName ?? "forwarded image";
        attachmentMedia.push({
          path: saved.path,
          contentType: saved.contentType,
          ...(saved.fileName ? { fileName: saved.fileName } : {}),
          placeholder: `[Forwarded image: ${label}]`,
        });
      } catch (error) {
        unavailableMediaCount += 1;
        slackMediaLog.warn(
          `slack: forwarded image unavailable (${formatSlackMediaFailure(error)})`,
        );
      }
    }
    attachmentMedia.push(...((await resolveFiles(att.files)) ?? []));
  }

  const allMedia = [...((await directMediaPromise) ?? []), ...attachmentMedia];
  const unavailableFiles = allFiles.flatMap((file, index) => {
    const reason =
      index >= MAX_SLACK_MEDIA_FILES ? SLACK_MEDIA_LIMIT_REASON : unavailableFileReasons.get(file);
    return reason ? [{ ...file, reason }] : [];
  });
  unavailableMediaCount += unavailableFiles.length;
  const combinedText = textBlocks.join("\n\n");
  if (
    !combinedText &&
    allMedia.length === 0 &&
    allFiles.length === 0 &&
    unavailableMediaCount === 0
  ) {
    return null;
  }
  return {
    text: combinedText,
    media: allMedia,
    unavailableMediaCount,
    ...(unavailableFiles.length > 0 ? { files: unavailableFiles } : {}),
  };
}
