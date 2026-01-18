import { detectMime, saveMediaBuffer } from "clawdbot/plugin-sdk";
import {
  extractInlineImageCandidates,
  inferPlaceholder,
  isLikelyImageAttachment,
  isRecord,
  isUrlAllowed,
  normalizeContentType,
  resolveAllowedHosts,
} from "./shared.js";
import type {
  MSTeamsAccessTokenProvider,
  MSTeamsAttachmentLike,
  MSTeamsInboundMedia,
} from "./types.js";

type DownloadCandidate = {
  url: string;
  fileHint?: string;
  contentTypeHint?: string;
  placeholder: string;
};

function resolveDownloadCandidate(att: MSTeamsAttachmentLike): DownloadCandidate | null {
  const contentType = normalizeContentType(att.contentType);
  const name = typeof att.name === "string" ? att.name.trim() : "";

  if (contentType === "application/vnd.microsoft.teams.file.download.info") {
    if (!isRecord(att.content)) return null;
    const downloadUrl =
      typeof att.content.downloadUrl === "string" ? att.content.downloadUrl.trim() : "";
    if (!downloadUrl) return null;

    const fileType = typeof att.content.fileType === "string" ? att.content.fileType.trim() : "";
    const uniqueId = typeof att.content.uniqueId === "string" ? att.content.uniqueId.trim() : "";
    const fileName = typeof att.content.fileName === "string" ? att.content.fileName.trim() : "";

    const fileHint = name || fileName || (uniqueId && fileType ? `${uniqueId}.${fileType}` : "");
    return {
      url: downloadUrl,
      fileHint: fileHint || undefined,
      contentTypeHint: undefined,
      placeholder: inferPlaceholder({
        contentType,
        fileName: fileHint,
        fileType,
      }),
    };
  }

  const contentUrl = typeof att.contentUrl === "string" ? att.contentUrl.trim() : "";
  if (!contentUrl) return null;

  return {
    url: contentUrl,
    fileHint: name || undefined,
    contentTypeHint: contentType,
    placeholder: inferPlaceholder({ contentType, fileName: name }),
  };
}

function scopeCandidatesForUrl(url: string): string[] {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const looksLikeGraph =
      host.endsWith("graph.microsoft.com") ||
      host.endsWith("sharepoint.com") ||
      host.endsWith("1drv.ms") ||
      host.includes("sharepoint");
    return looksLikeGraph
      ? ["https://graph.microsoft.com/.default", "https://api.botframework.com/.default"]
      : ["https://api.botframework.com/.default", "https://graph.microsoft.com/.default"];
  } catch {
    return ["https://api.botframework.com/.default", "https://graph.microsoft.com/.default"];
  }
}

async function fetchWithAuthFallback(params: {
  url: string;
  tokenProvider?: MSTeamsAccessTokenProvider;
  fetchFn?: typeof fetch;
}): Promise<Response> {
  const fetchFn = params.fetchFn ?? fetch;
  const firstAttempt = await fetchFn(params.url);
  if (firstAttempt.ok) return firstAttempt;
  if (!params.tokenProvider) return firstAttempt;
  if (firstAttempt.status !== 401 && firstAttempt.status !== 403) return firstAttempt;

  const scopes = scopeCandidatesForUrl(params.url);
  for (const scope of scopes) {
    try {
      const token = await params.tokenProvider.getAccessToken(scope);
      const res = await fetchFn(params.url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) return res;
    } catch {
      // Try the next scope.
    }
  }

  return firstAttempt;
}

export async function downloadMSTeamsImageAttachments(params: {
  attachments: MSTeamsAttachmentLike[] | undefined;
  maxBytes: number;
  tokenProvider?: MSTeamsAccessTokenProvider;
  allowHosts?: string[];
  fetchFn?: typeof fetch;
}): Promise<MSTeamsInboundMedia[]> {
  const list = Array.isArray(params.attachments) ? params.attachments : [];
  if (list.length === 0) return [];
  const allowHosts = resolveAllowedHosts(params.allowHosts);

  const candidates: DownloadCandidate[] = list
    .filter(isLikelyImageAttachment)
    .map(resolveDownloadCandidate)
    .filter(Boolean) as DownloadCandidate[];

  const inlineCandidates = extractInlineImageCandidates(list);
  const seenUrls = new Set<string>();
  for (const inline of inlineCandidates) {
    if (inline.kind === "url") {
      if (!isUrlAllowed(inline.url, allowHosts)) continue;
      if (seenUrls.has(inline.url)) continue;
      seenUrls.add(inline.url);
      candidates.push({
        url: inline.url,
        fileHint: inline.fileHint,
        contentTypeHint: inline.contentType,
        placeholder: inline.placeholder,
      });
    }
  }

  if (candidates.length === 0 && inlineCandidates.length === 0) return [];

  const out: MSTeamsInboundMedia[] = [];
  for (const inline of inlineCandidates) {
    if (inline.kind !== "data") continue;
    if (inline.data.byteLength > params.maxBytes) continue;
    try {
      const saved = await saveMediaBuffer(
        inline.data,
        inline.contentType,
        "inbound",
        params.maxBytes,
      );
      out.push({
        path: saved.path,
        contentType: saved.contentType,
        placeholder: inline.placeholder,
      });
    } catch {
      // Ignore decode failures and continue.
    }
  }
  for (const candidate of candidates) {
    if (!isUrlAllowed(candidate.url, allowHosts)) continue;
    try {
      const res = await fetchWithAuthFallback({
        url: candidate.url,
        tokenProvider: params.tokenProvider,
        fetchFn: params.fetchFn,
      });
      if (!res.ok) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.byteLength > params.maxBytes) continue;
      const mime = await detectMime({
        buffer,
        headerMime: res.headers.get("content-type"),
        filePath: candidate.fileHint ?? candidate.url,
      });
      const saved = await saveMediaBuffer(
        buffer,
        mime ?? candidate.contentTypeHint,
        "inbound",
        params.maxBytes,
      );
      out.push({
        path: saved.path,
        contentType: saved.contentType,
        placeholder: candidate.placeholder,
      });
    } catch {
      // Ignore download failures and continue.
    }
  }
  return out;
}
