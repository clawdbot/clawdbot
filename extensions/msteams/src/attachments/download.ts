// Msteams plugin module implements download behavior.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveMSTeamsRequestTimeoutMs,
  type MSTeamsRequestDeadline,
  withMSTeamsRequestDeadline,
} from "../request-timeout.js";
import { getMSTeamsRuntime } from "../runtime.js";
import { resolveMSTeamsAdvertisedMedia } from "./html.js";
import { downloadAndStoreMSTeamsRemoteMedia } from "./remote-media.js";
import {
  extractInlineImageCandidates,
  isAdvertisedFileAttachment,
  isDownloadableAttachment,
  isRecord,
  isUrlAllowed,
  type MSTeamsAttachmentDownloadLogger,
  type MSTeamsAttachmentFetchPolicy,
  type MSTeamsAttachmentResolveFn,
  normalizeContentType,
  resolveMSTeamsMediaKind,
  resolveMediaSsrfPolicy,
  resolveAttachmentFetchPolicy,
  resolveRequestUrl,
  safeFetchWithPolicy,
  tryBuildGraphSharesUrlForSharedLink,
} from "./shared.js";
import type {
  MSTeamsAccessTokenProvider,
  MSTeamsAttachmentLike,
  MSTeamsInboundMedia,
} from "./types.js";

type DownloadCandidate =
  | {
      kind: "remote";
      mediaKind: "image" | "document";
      url: string;
      fileHint?: string;
      contentTypeHint?: string;
      sourceId?: string;
    }
  | {
      kind: "data";
      mediaKind: "image";
      data: Buffer;
      contentType?: string;
      sourceId?: string;
    }
  | { kind: "unavailable"; mediaKind: "image" | "document"; sourceId?: string };

function withSourceId(
  media: MSTeamsInboundMedia,
  sourceId: string | undefined,
): MSTeamsInboundMedia {
  return sourceId ? { ...media, sourceId } : media;
}

function resolveDownloadCandidate(att: MSTeamsAttachmentLike): DownloadCandidate | null {
  const contentType = normalizeContentType(att.contentType);
  const name = normalizeOptionalString(att.name) ?? "";

  if (contentType === "application/vnd.microsoft.teams.file.download.info") {
    if (!isRecord(att.content)) {
      return null;
    }
    const downloadUrl = normalizeOptionalString(att.content.downloadUrl) ?? "";
    if (!downloadUrl) {
      return null;
    }

    const fileType = normalizeOptionalString(att.content.fileType) ?? "";
    const uniqueId = normalizeOptionalString(att.content.uniqueId) ?? "";
    const fileName = normalizeOptionalString(att.content.fileName) ?? "";

    const fileHint = name || fileName || (uniqueId && fileType ? `${uniqueId}.${fileType}` : "");
    return {
      kind: "remote",
      mediaKind: resolveMSTeamsMediaKind({ contentType, fileName: fileHint, fileType }),
      url: downloadUrl,
      fileHint: fileHint || undefined,
      contentTypeHint: undefined,
      sourceId: att.id?.trim() || undefined,
    };
  }

  const contentUrl = normalizeOptionalString(att.contentUrl) ?? "";
  if (!contentUrl) {
    return null;
  }

  // OneDrive/SharePoint shared links (delivered in 1:1 DMs when the user
  // picks "Attach > OneDrive") cannot be fetched directly — the URL returns
  // an HTML landing page rather than the file bytes. Rewrite them to the
  // Graph shares endpoint so the auth fallback attaches a Graph-scoped token
  // and the response is the real file content.
  const sharesUrl = tryBuildGraphSharesUrlForSharedLink(contentUrl);
  const resolvedUrl = sharesUrl ?? contentUrl;
  // Graph shares returns raw bytes without a declared content type we can
  // trust for routing — let the downloader infer MIME from the buffer.
  const resolvedContentTypeHint = sharesUrl ? undefined : contentType;

  return {
    kind: "remote",
    mediaKind: resolveMSTeamsMediaKind({ contentType, fileName: name }),
    url: resolvedUrl,
    fileHint: name || undefined,
    contentTypeHint: resolvedContentTypeHint,
    sourceId: att.id?.trim() || undefined,
  };
}

function scopeCandidatesForUrl(url: string): string[] {
  try {
    const host = normalizeLowercaseStringOrEmpty(new URL(url).hostname);
    const looksLikeGraph =
      host.endsWith("graph.microsoft.com") ||
      host.endsWith("sharepoint.com") ||
      host.endsWith("1drv.ms") ||
      host.includes("sharepoint");
    return looksLikeGraph
      ? ["https://graph.microsoft.com", "https://api.botframework.com"]
      : ["https://api.botframework.com", "https://graph.microsoft.com"];
  } catch {
    return ["https://api.botframework.com", "https://graph.microsoft.com"];
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function resolveInlineDataImageMime(inline: {
  data: Buffer;
  contentType?: string;
}): Promise<string | undefined> {
  const detectedMime = await getMSTeamsRuntime().media.detectMime({
    buffer: inline.data,
    headerMime: inline.contentType,
  });
  const mime = normalizeOptionalLowercaseString(detectedMime ?? inline.contentType);
  return mime?.startsWith("image/") ? mime : undefined;
}

async function fetchWithAuthFallback(params: {
  url: string;
  tokenProvider?: MSTeamsAccessTokenProvider;
  fetchFn?: typeof fetch;
  fetchFnSupportsDispatcher?: boolean;
  requestInit?: RequestInit;
  resolveFn?: MSTeamsAttachmentResolveFn;
  policy: MSTeamsAttachmentFetchPolicy;
  deadline?: MSTeamsRequestDeadline;
}): Promise<Response> {
  const firstAttempt = await safeFetchWithPolicy({
    url: params.url,
    policy: params.policy,
    fetchFn: params.fetchFn,
    fetchFnSupportsDispatcher: params.fetchFnSupportsDispatcher,
    requestInit: params.requestInit,
    resolveFn: params.resolveFn,
    timeoutMs: resolveMSTeamsRequestTimeoutMs(params.deadline),
  });
  if (firstAttempt.ok) {
    return firstAttempt;
  }
  if (!params.tokenProvider) {
    return firstAttempt;
  }
  const tokenProvider = params.tokenProvider;
  if (firstAttempt.status !== 401 && firstAttempt.status !== 403) {
    return firstAttempt;
  }
  if (!isUrlAllowed(params.url, params.policy.authAllowHosts)) {
    return firstAttempt;
  }
  await firstAttempt.body?.cancel();

  const scopes = scopeCandidatesForUrl(params.url);
  const fetchFn = params.fetchFn ?? fetch;
  for (const scope of scopes) {
    try {
      const token = await withMSTeamsRequestDeadline({
        deadline: params.deadline,
        label: "MS Teams attachment token",
        work: () => tokenProvider.getAccessToken(scope),
      });
      const authHeaders = new Headers(params.requestInit?.headers);
      authHeaders.set("Authorization", `Bearer ${token}`);
      const authAttempt = await safeFetchWithPolicy({
        url: params.url,
        policy: params.policy,
        fetchFn,
        fetchFnSupportsDispatcher: params.fetchFnSupportsDispatcher,
        requestInit: {
          ...params.requestInit,
          headers: authHeaders,
        },
        resolveFn: params.resolveFn,
        timeoutMs: resolveMSTeamsRequestTimeoutMs(params.deadline),
      });
      if (authAttempt.ok) {
        return authAttempt;
      }
      if (isRedirectStatus(authAttempt.status)) {
        // Redirects in guarded fetch mode must propagate to the outer guard.
        return authAttempt;
      }
      if (authAttempt.status !== 401 && authAttempt.status !== 403) {
        // Preserve scope fallback semantics for non-auth failures.
        await authAttempt.body?.cancel();
        continue;
      }
      await authAttempt.body?.cancel();
    } catch {
      // Try the next scope.
    }
  }

  return firstAttempt;
}

/**
 * Download all file attachments from a Teams message (images, documents, etc.).
 * Renamed from downloadMSTeamsImageAttachments to support all file types.
 */
export async function downloadMSTeamsAttachments(params: {
  attachments: MSTeamsAttachmentLike[] | undefined;
  maxBytes: number;
  tokenProvider?: MSTeamsAccessTokenProvider;
  allowHosts?: string[];
  authAllowHosts?: string[];
  fetchFn?: typeof fetch;
  fetchFnSupportsDispatcher?: boolean;
  resolveFn?: MSTeamsAttachmentResolveFn;
  deadline?: MSTeamsRequestDeadline;
  /** When true, embeds original filename in stored path for later extraction. */
  preserveFilenames?: boolean;
  /**
   * Optional logger used to surface inline data decode failures and remote
   * media download errors. Errors that are not logged here are invisible at
   * INFO level and block diagnosis of issues like #63396.
   */
  logger?: MSTeamsAttachmentDownloadLogger;
}): Promise<MSTeamsInboundMedia[]> {
  const list = Array.isArray(params.attachments) ? params.attachments : [];
  if (list.length === 0) {
    return [];
  }
  const policy = resolveAttachmentFetchPolicy({
    allowHosts: params.allowHosts,
    authAllowHosts: params.authAllowHosts,
  });
  const allowHosts = policy.allowHosts;
  const ssrfPolicy = resolveMediaSsrfPolicy(allowHosts);

  const candidates: DownloadCandidate[] = list
    .filter(isAdvertisedFileAttachment)
    .map((attachment) => {
      const candidate = isDownloadableAttachment(attachment)
        ? resolveDownloadCandidate(attachment)
        : null;
      return (
        candidate ?? {
          kind: "unavailable",
          mediaKind: resolveMSTeamsMediaKind({
            contentType: normalizeContentType(attachment.contentType),
            fileName: attachment.name ?? undefined,
          }),
          sourceId: attachment.id?.trim() || undefined,
        }
      );
    });
  candidates.push(
    ...extractInlineImageCandidates(list, {
      maxInlineBytes: params.maxBytes,
      maxInlineTotalBytes: params.maxBytes,
    }).map((candidate): DownloadCandidate => {
      if (candidate.kind === "data") {
        return {
          kind: "data",
          mediaKind: "image",
          data: candidate.data,
          contentType: candidate.contentType,
          sourceId: candidate.sourceId,
        };
      }
      if (candidate.kind === "url") {
        return {
          kind: "remote",
          mediaKind: "image",
          url: candidate.url,
          fileHint: candidate.fileHint,
          contentTypeHint: candidate.contentType,
          sourceId: candidate.sourceId,
        };
      }
      return { kind: "unavailable", mediaKind: "image", sourceId: candidate.sourceId };
    }),
  );
  const advertisedMedia = resolveMSTeamsAdvertisedMedia(list, {
    maxInlineBytes: params.maxBytes,
    maxInlineTotalBytes: params.maxBytes,
  });
  for (const advertised of advertisedMedia.slice(candidates.length)) {
    candidates.push({
      kind: "unavailable",
      mediaKind: advertised.kind,
      sourceId: advertised.sourceId,
    });
  }
  if (candidates.length === 0) {
    return [];
  }

  const out: MSTeamsInboundMedia[] = [];
  for (const candidate of candidates) {
    if (candidate.kind === "unavailable") {
      out.push(withSourceId({ kind: candidate.mediaKind }, candidate.sourceId));
      continue;
    }
    if (candidate.kind === "data") {
      try {
        const contentType = await resolveInlineDataImageMime(candidate);
        if (!contentType) {
          out.push(withSourceId({ kind: candidate.mediaKind }, candidate.sourceId));
          continue;
        }
        const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(
          candidate.data,
          contentType,
          "inbound",
          params.maxBytes,
        );
        out.push(
          withSourceId(
            { path: saved.path, contentType: saved.contentType, kind: "image" },
            candidate.sourceId,
          ),
        );
      } catch (err) {
        out.push(withSourceId({ kind: candidate.mediaKind }, candidate.sourceId));
        params.logger?.warn?.("msteams inline attachment decode failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    if (!isUrlAllowed(candidate.url, allowHosts)) {
      out.push(withSourceId({ kind: candidate.mediaKind }, candidate.sourceId));
      continue;
    }
    try {
      const media = await downloadAndStoreMSTeamsRemoteMedia({
        url: candidate.url,
        filePathHint: candidate.fileHint ?? candidate.url,
        maxBytes: params.maxBytes,
        contentTypeHint: candidate.contentTypeHint,
        kind: candidate.mediaKind,
        preserveFilenames: params.preserveFilenames,
        ssrfPolicy,
        // `fetchImpl` below owns Teams auth fallback and enforces the
        // attachment fetch policy through `safeFetchWithPolicy`.
        useDirectFetch: true,
        fetchImpl: (input, init) =>
          fetchWithAuthFallback({
            url: resolveRequestUrl(input),
            tokenProvider: params.tokenProvider,
            fetchFn: params.fetchFn,
            fetchFnSupportsDispatcher: params.fetchFnSupportsDispatcher,
            requestInit: init,
            resolveFn: params.resolveFn,
            policy,
            deadline: params.deadline,
          }),
      });
      out.push(withSourceId(media, candidate.sourceId));
    } catch (err) {
      out.push(withSourceId({ kind: candidate.mediaKind }, candidate.sourceId));
      const msg = err instanceof Error ? err.message : String(err);
      params.logger?.warn?.(
        `msteams attachment download failed host=${safeHostForLog(candidate.url)} error=${msg}`,
      );
    }
  }
  return out;
}

function safeHostForLog(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}
