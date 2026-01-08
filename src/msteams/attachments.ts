import { detectMime } from "../media/mime.js";
import { saveMediaBuffer } from "../media/store.js";

export type MSTeamsAttachmentLike = {
  contentType?: string | null;
  contentUrl?: string | null;
  name?: string | null;
  thumbnailUrl?: string | null;
  content?: unknown;
};

export type MSTeamsAccessTokenProvider = {
  getAccessToken: (scope: string) => Promise<string>;
};

type DownloadCandidate = {
  url: string;
  fileHint?: string;
  contentTypeHint?: string;
  placeholder: string;
};

export type MSTeamsInboundMedia = {
  path: string;
  contentType?: string;
  placeholder: string;
};

type InlineImageCandidate =
  | {
      kind: "data";
      data: Buffer;
      contentType?: string;
      placeholder: string;
    }
  | {
      kind: "url";
      url: string;
      contentType?: string;
      fileHint?: string;
      placeholder: string;
    };

const IMAGE_EXT_RE = /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;

const IMG_SRC_RE = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
const ATTACHMENT_TAG_RE = /<attachment[^>]+id=["']([^"']+)["'][^>]*>/gi;

export type MSTeamsHtmlAttachmentSummary = {
  htmlAttachments: number;
  imgTags: number;
  dataImages: number;
  cidImages: number;
  srcHosts: string[];
  attachmentTags: number;
  attachmentIds: string[];
};

export type MSTeamsGraphMediaResult = {
  media: MSTeamsInboundMedia[];
  hostedCount?: number;
  attachmentCount?: number;
  hostedStatus?: number;
  attachmentStatus?: number;
  messageUrl?: string;
  tokenError?: boolean;
};

type GraphHostedContent = {
  id?: string | null;
  contentType?: string | null;
  contentBytes?: string | null;
};

type GraphAttachment = {
  id?: string | null;
  contentType?: string | null;
  contentUrl?: string | null;
  name?: string | null;
  thumbnailUrl?: string | null;
  content?: unknown;
};

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeContentType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function inferPlaceholder(params: {
  contentType?: string;
  fileName?: string;
  fileType?: string;
}): string {
  const mime = params.contentType?.toLowerCase() ?? "";
  const name = params.fileName?.toLowerCase() ?? "";
  const fileType = params.fileType?.toLowerCase() ?? "";

  const looksLikeImage =
    mime.startsWith("image/") ||
    IMAGE_EXT_RE.test(name) ||
    IMAGE_EXT_RE.test(`x.${fileType}`);

  return looksLikeImage ? "<media:image>" : "<media:document>";
}

function isLikelyImageAttachment(att: MSTeamsAttachmentLike): boolean {
  const contentType = normalizeContentType(att.contentType) ?? "";
  const name = typeof att.name === "string" ? att.name : "";
  if (contentType.startsWith("image/")) return true;
  if (IMAGE_EXT_RE.test(name)) return true;

  if (
    contentType === "application/vnd.microsoft.teams.file.download.info" &&
    isRecord(att.content)
  ) {
    const fileType =
      typeof att.content.fileType === "string" ? att.content.fileType : "";
    if (fileType && IMAGE_EXT_RE.test(`x.${fileType}`)) return true;
    const fileName =
      typeof att.content.fileName === "string" ? att.content.fileName : "";
    if (fileName && IMAGE_EXT_RE.test(fileName)) return true;
  }

  return false;
}

function isHtmlAttachment(att: MSTeamsAttachmentLike): boolean {
  const contentType = normalizeContentType(att.contentType) ?? "";
  return contentType.startsWith("text/html");
}

function extractHtmlFromAttachment(
  att: MSTeamsAttachmentLike,
): string | undefined {
  if (!isHtmlAttachment(att)) return undefined;
  if (typeof att.content === "string") return att.content;
  if (!isRecord(att.content)) return undefined;
  const text =
    typeof att.content.text === "string"
      ? att.content.text
      : typeof att.content.body === "string"
        ? att.content.body
        : typeof att.content.content === "string"
          ? att.content.content
          : undefined;
  return text;
}

function decodeDataImage(src: string): InlineImageCandidate | null {
  const match = /^data:(image\/[a-z0-9.+-]+)?(;base64)?,(.*)$/i.exec(src);
  if (!match) return null;
  const contentType = match[1]?.toLowerCase();
  const isBase64 = Boolean(match[2]);
  if (!isBase64) return null;
  const payload = match[3] ?? "";
  if (!payload) return null;
  try {
    const data = Buffer.from(payload, "base64");
    return {
      kind: "data",
      data,
      contentType,
      placeholder: "<media:image>",
    };
  } catch {
    return null;
  }
}

function fileHintFromUrl(src: string): string | undefined {
  try {
    const url = new URL(src);
    const name = url.pathname.split("/").pop();
    return name || undefined;
  } catch {
    return undefined;
  }
}

function extractInlineImageCandidates(
  attachments: MSTeamsAttachmentLike[],
): InlineImageCandidate[] {
  const out: InlineImageCandidate[] = [];
  for (const att of attachments) {
    const html = extractHtmlFromAttachment(att);
    if (!html) continue;
    IMG_SRC_RE.lastIndex = 0;
    let match: RegExpExecArray | null = IMG_SRC_RE.exec(html);
    while (match) {
      const src = match[1]?.trim();
      if (src && !src.startsWith("cid:")) {
        if (src.startsWith("data:")) {
          const decoded = decodeDataImage(src);
          if (decoded) out.push(decoded);
        } else {
          out.push({
            kind: "url",
            url: src,
            fileHint: fileHintFromUrl(src),
            placeholder: "<media:image>",
          });
        }
      }
      match = IMG_SRC_RE.exec(html);
    }
  }
  return out;
}

function safeHostForUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "invalid-url";
  }
}

export function summarizeMSTeamsHtmlAttachments(
  attachments: MSTeamsAttachmentLike[] | undefined,
): MSTeamsHtmlAttachmentSummary | undefined {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return undefined;
  let htmlAttachments = 0;
  let imgTags = 0;
  let dataImages = 0;
  let cidImages = 0;
  const srcHosts = new Set<string>();
  let attachmentTags = 0;
  const attachmentIds = new Set<string>();

  for (const att of list) {
    const html = extractHtmlFromAttachment(att);
    if (!html) continue;
    htmlAttachments += 1;
    IMG_SRC_RE.lastIndex = 0;
    let match: RegExpExecArray | null = IMG_SRC_RE.exec(html);
    while (match) {
      imgTags += 1;
      const src = match[1]?.trim();
      if (src) {
        if (src.startsWith("data:")) dataImages += 1;
        else if (src.startsWith("cid:")) cidImages += 1;
        else srcHosts.add(safeHostForUrl(src));
      }
      match = IMG_SRC_RE.exec(html);
    }
    ATTACHMENT_TAG_RE.lastIndex = 0;
    match = ATTACHMENT_TAG_RE.exec(html);
    while (match) {
      attachmentTags += 1;
      const id = match[1]?.trim();
      if (id) attachmentIds.add(id);
      match = ATTACHMENT_TAG_RE.exec(html);
    }
  }

  if (htmlAttachments === 0) return undefined;
  return {
    htmlAttachments,
    imgTags,
    dataImages,
    cidImages,
    srcHosts: Array.from(srcHosts).slice(0, 5),
    attachmentTags,
    attachmentIds: Array.from(attachmentIds).slice(0, 5),
  };
}

function readNestedString(
  value: unknown,
  keys: Array<string | number>,
): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key as keyof typeof current];
  }
  return typeof current === "string" && current.trim()
    ? current.trim()
    : undefined;
}

export function buildMSTeamsGraphMessageUrls(params: {
  conversationType?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  replyToId?: string | null;
  conversationMessageId?: string | null;
  channelData?: unknown;
}): string[] {
  const conversationType = params.conversationType?.trim().toLowerCase() ?? "";
  const messageIdCandidates = new Set<string>();
  const pushCandidate = (value: string | null | undefined) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) messageIdCandidates.add(trimmed);
  };

  pushCandidate(params.messageId);
  pushCandidate(params.conversationMessageId);
  pushCandidate(readNestedString(params.channelData, ["messageId"]));
  pushCandidate(readNestedString(params.channelData, ["teamsMessageId"]));

  const replyToId =
    typeof params.replyToId === "string" ? params.replyToId.trim() : "";

  if (conversationType === "channel") {
    const teamId =
      readNestedString(params.channelData, ["team", "id"]) ??
      readNestedString(params.channelData, ["teamId"]);
    const channelId =
      readNestedString(params.channelData, ["channel", "id"]) ??
      readNestedString(params.channelData, ["channelId"]) ??
      readNestedString(params.channelData, ["teamsChannelId"]);
    if (!teamId || !channelId) return [];
    const urls: string[] = [];
    if (replyToId) {
      for (const candidate of messageIdCandidates) {
        if (candidate === replyToId) continue;
        urls.push(
          `${GRAPH_ROOT}/teams/${encodeURIComponent(
            teamId,
          )}/channels/${encodeURIComponent(
            channelId,
          )}/messages/${encodeURIComponent(
            replyToId,
          )}/replies/${encodeURIComponent(candidate)}`,
        );
      }
    }
    if (messageIdCandidates.size === 0 && replyToId) {
      messageIdCandidates.add(replyToId);
    }
    for (const candidate of messageIdCandidates) {
      urls.push(
        `${GRAPH_ROOT}/teams/${encodeURIComponent(
          teamId,
        )}/channels/${encodeURIComponent(
          channelId,
        )}/messages/${encodeURIComponent(candidate)}`,
      );
    }
    return Array.from(new Set(urls));
  }

  const chatId =
    params.conversationId?.trim() ||
    readNestedString(params.channelData, ["chatId"]);
  if (!chatId) return [];
  if (messageIdCandidates.size === 0 && replyToId) {
    messageIdCandidates.add(replyToId);
  }
  const urls = Array.from(messageIdCandidates).map(
    (candidate) =>
      `${GRAPH_ROOT}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(candidate)}`,
  );
  return Array.from(new Set(urls));
}

async function fetchGraphCollection<T>(params: {
  url: string;
  accessToken: string;
  fetchFn?: typeof fetch;
}): Promise<{ status: number; items: T[] }> {
  const fetchFn = params.fetchFn ?? fetch;
  const res = await fetchFn(params.url, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  const status = res.status;
  if (!res.ok) return { status, items: [] };
  try {
    const data = (await res.json()) as { value?: T[] };
    return { status, items: Array.isArray(data.value) ? data.value : [] };
  } catch {
    return { status, items: [] };
  }
}

function normalizeGraphAttachment(att: GraphAttachment): MSTeamsAttachmentLike {
  let content: unknown = att.content;
  if (typeof content === "string") {
    try {
      content = JSON.parse(content);
    } catch {
      // Keep as raw string if it's not JSON.
    }
  }
  return {
    contentType: att.contentType ?? undefined,
    contentUrl: att.contentUrl ?? undefined,
    name: att.name ?? undefined,
    thumbnailUrl: att.thumbnailUrl ?? undefined,
    content,
  };
}

async function downloadGraphHostedImages(params: {
  accessToken: string;
  messageUrl: string;
  maxBytes: number;
  fetchFn?: typeof fetch;
}): Promise<{ media: MSTeamsInboundMedia[]; status: number; count: number }> {
  const hosted = await fetchGraphCollection<GraphHostedContent>({
    url: `${params.messageUrl}/hostedContents`,
    accessToken: params.accessToken,
    fetchFn: params.fetchFn,
  });
  if (hosted.items.length === 0) {
    return { media: [], status: hosted.status, count: 0 };
  }

  const out: MSTeamsInboundMedia[] = [];
  for (const item of hosted.items) {
    const contentBytes =
      typeof item.contentBytes === "string" ? item.contentBytes : "";
    if (!contentBytes) continue;
    let buffer: Buffer;
    try {
      buffer = Buffer.from(contentBytes, "base64");
    } catch {
      continue;
    }
    if (buffer.byteLength > params.maxBytes) continue;
    const mime = await detectMime({
      buffer,
      headerMime: item.contentType ?? undefined,
    });
    if (mime && !mime.startsWith("image/")) continue;
    try {
      const saved = await saveMediaBuffer(
        buffer,
        mime ?? item.contentType ?? undefined,
        "inbound",
        params.maxBytes,
      );
      out.push({
        path: saved.path,
        contentType: saved.contentType,
        placeholder: "<media:image>",
      });
    } catch {
      // Ignore save failures.
    }
  }

  return { media: out, status: hosted.status, count: hosted.items.length };
}

export async function downloadMSTeamsGraphMedia(params: {
  messageUrl?: string | null;
  tokenProvider?: MSTeamsAccessTokenProvider;
  maxBytes: number;
  fetchFn?: typeof fetch;
}): Promise<MSTeamsGraphMediaResult> {
  if (!params.messageUrl || !params.tokenProvider) {
    return { media: [] };
  }
  const messageUrl = params.messageUrl;
  let accessToken: string;
  try {
    accessToken = await params.tokenProvider.getAccessToken(
      "https://graph.microsoft.com/.default",
    );
  } catch {
    return { media: [], messageUrl, tokenError: true };
  }

  const hosted = await downloadGraphHostedImages({
    accessToken,
    messageUrl,
    maxBytes: params.maxBytes,
    fetchFn: params.fetchFn,
  });

  const attachments = await fetchGraphCollection<GraphAttachment>({
    url: `${messageUrl}/attachments`,
    accessToken,
    fetchFn: params.fetchFn,
  });

  const normalizedAttachments = attachments.items.map(normalizeGraphAttachment);
  const attachmentMedia = await downloadMSTeamsImageAttachments({
    attachments: normalizedAttachments,
    maxBytes: params.maxBytes,
    tokenProvider: params.tokenProvider,
    fetchFn: params.fetchFn,
  });

  return {
    media: [...hosted.media, ...attachmentMedia],
    hostedCount: hosted.count,
    attachmentCount: attachments.items.length,
    hostedStatus: hosted.status,
    attachmentStatus: attachments.status,
    messageUrl,
  };
}

export function buildMSTeamsAttachmentPlaceholder(
  attachments: MSTeamsAttachmentLike[] | undefined,
): string {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return "";
  const imageCount = list.filter(isLikelyImageAttachment).length;
  const inlineCount = extractInlineImageCandidates(list).length;
  const totalImages = imageCount + inlineCount;
  if (totalImages > 0) {
    return `<media:image>${totalImages > 1 ? ` (${totalImages} images)` : ""}`;
  }
  const count = list.length;
  return `<media:document>${count > 1 ? ` (${count} files)` : ""}`;
}

function resolveDownloadCandidate(
  att: MSTeamsAttachmentLike,
): DownloadCandidate | null {
  const contentType = normalizeContentType(att.contentType);
  const name = typeof att.name === "string" ? att.name.trim() : "";

  if (contentType === "application/vnd.microsoft.teams.file.download.info") {
    if (!isRecord(att.content)) return null;
    const downloadUrl =
      typeof att.content.downloadUrl === "string"
        ? att.content.downloadUrl.trim()
        : "";
    if (!downloadUrl) return null;

    const fileType =
      typeof att.content.fileType === "string"
        ? att.content.fileType.trim()
        : "";
    const uniqueId =
      typeof att.content.uniqueId === "string"
        ? att.content.uniqueId.trim()
        : "";
    const fileName =
      typeof att.content.fileName === "string"
        ? att.content.fileName.trim()
        : "";

    const fileHint =
      name ||
      fileName ||
      (uniqueId && fileType ? `${uniqueId}.${fileType}` : "");
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

  const contentUrl =
    typeof att.contentUrl === "string" ? att.contentUrl.trim() : "";
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
      ? [
          "https://graph.microsoft.com/.default",
          "https://api.botframework.com/.default",
        ]
      : [
          "https://api.botframework.com/.default",
          "https://graph.microsoft.com/.default",
        ];
  } catch {
    return [
      "https://api.botframework.com/.default",
      "https://graph.microsoft.com/.default",
    ];
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
  if (firstAttempt.status !== 401 && firstAttempt.status !== 403)
    return firstAttempt;

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
  fetchFn?: typeof fetch;
}): Promise<MSTeamsInboundMedia[]> {
  const list = Array.isArray(params.attachments) ? params.attachments : [];
  if (list.length === 0) return [];

  const candidates: DownloadCandidate[] = list
    .filter(isLikelyImageAttachment)
    .map(resolveDownloadCandidate)
    .filter(Boolean) as DownloadCandidate[];

  const inlineCandidates = extractInlineImageCandidates(list);
  const seenUrls = new Set<string>();
  for (const inline of inlineCandidates) {
    if (inline.kind === "url") {
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
        headerMime:
          candidate.contentTypeHint ?? res.headers.get("content-type"),
        filePath: candidate.fileHint ?? candidate.url,
      });
      const saved = await saveMediaBuffer(
        buffer,
        mime,
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

export function buildMSTeamsMediaPayload(
  mediaList: Array<{ path: string; contentType?: string }>,
): {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
} {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const mediaTypes = mediaList.map((media) => media.contentType ?? "");
  return {
    MediaPath: first?.path,
    MediaType: first?.contentType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaPaths.length > 0 ? mediaTypes : undefined,
  };
}
