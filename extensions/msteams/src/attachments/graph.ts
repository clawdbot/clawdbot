import { getMSTeamsRuntime } from "../runtime.js";
import { downloadMSTeamsAttachments } from "./download.js";
import { GRAPH_ROOT, inferPlaceholder, isRecord, normalizeContentType, resolveAllowedHosts } from "./shared.js";
import type {
  MSTeamsAccessTokenProvider,
  MSTeamsAttachmentLike,
  MSTeamsGraphMediaResult,
  MSTeamsInboundMedia,
} from "./types.js";

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

function readNestedString(value: unknown, keys: Array<string | number>): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key as keyof typeof current];
  }
  return typeof current === "string" && current.trim() ? current.trim() : undefined;
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

  const replyToId = typeof params.replyToId === "string" ? params.replyToId.trim() : "";

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
          `${GRAPH_ROOT}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(replyToId)}/replies/${encodeURIComponent(candidate)}`,
        );
      }
    }
    if (messageIdCandidates.size === 0 && replyToId) messageIdCandidates.add(replyToId);
    for (const candidate of messageIdCandidates) {
      urls.push(
        `${GRAPH_ROOT}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(candidate)}`,
      );
    }
    return Array.from(new Set(urls));
  }

  const chatId = params.conversationId?.trim() || readNestedString(params.channelData, ["chatId"]);
  if (!chatId) return [];
  if (messageIdCandidates.size === 0 && replyToId) messageIdCandidates.add(replyToId);
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
    contentType: normalizeContentType(att.contentType) ?? undefined,
    contentUrl: att.contentUrl ?? undefined,
    name: att.name ?? undefined,
    thumbnailUrl: att.thumbnailUrl ?? undefined,
    content,
  };
}

/**
 * Download all hosted content from a Teams message (images, documents, etc.).
 * Renamed from downloadGraphHostedImages to support all file types.
 */
async function downloadGraphHostedContent(params: {
  accessToken: string;
  messageUrl: string;
  maxBytes: number;
  fetchFn?: typeof fetch;
  preserveFilenames?: boolean;
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
    const contentBytes = typeof item.contentBytes === "string" ? item.contentBytes : "";
    if (!contentBytes) continue;
    let buffer: Buffer;
    try {
      buffer = Buffer.from(contentBytes, "base64");
    } catch {
      continue;
    }
    if (buffer.byteLength > params.maxBytes) continue;
    const mime = await getMSTeamsRuntime().media.detectMime({
      buffer,
      headerMime: item.contentType ?? undefined,
    });
    // Download any file type, not just images
    try {
      const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(
        buffer,
        mime ?? item.contentType ?? undefined,
        "inbound",
        params.maxBytes,
      );
      out.push({
        path: saved.path,
        contentType: saved.contentType,
        placeholder: inferPlaceholder({ contentType: saved.contentType }),
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
  allowHosts?: string[];
  fetchFn?: typeof fetch;
  /** When true, embeds original filename in stored path for later extraction. */
  preserveFilenames?: boolean;
}): Promise<MSTeamsGraphMediaResult> {
  if (!params.messageUrl || !params.tokenProvider) return { media: [] };
  const allowHosts = resolveAllowedHosts(params.allowHosts);
  const messageUrl = params.messageUrl;
  let accessToken: string;
  try {
    accessToken = await params.tokenProvider.getAccessToken("https://graph.microsoft.com/.default");
  } catch {
    return { media: [], messageUrl, tokenError: true };
  }

  // Fetch the full message to get SharePoint file attachments (for group chats)
  const fetchFn = params.fetchFn ?? fetch;
  const sharePointMedia: MSTeamsInboundMedia[] = [];
  const downloadedReferenceUrls = new Set<string>();
  try {
    const msgRes = await fetchFn(messageUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (msgRes.ok) {
      const msgData = (await msgRes.json()) as {
        body?: { content?: string; contentType?: string };
        attachments?: Array<{
          id?: string;
          contentUrl?: string;
          contentType?: string;
          name?: string;
        }>;
      };

      // Extract SharePoint file attachments (contentType: "reference")
      // Download any file type, not just images
      const spAttachments = (msgData.attachments ?? []).filter(
        (a) => a.contentType === "reference" && a.contentUrl && a.name,
      );
      for (const att of spAttachments) {
        const name = att.name ?? "file";

        try {
          // SharePoint URLs need to be accessed via Graph shares API
          const shareUrl = att.contentUrl!;
          const encodedUrl = Buffer.from(shareUrl).toString("base64url");
          const sharesUrl = `${GRAPH_ROOT}/shares/u!${encodedUrl}/driveItem/content`;

          const spRes = await fetchFn(sharesUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
            redirect: "follow",
          });

          if (spRes.ok) {
            const buffer = Buffer.from(await spRes.arrayBuffer());
            if (buffer.byteLength <= params.maxBytes) {
              const mime = await getMSTeamsRuntime().media.detectMime({
                buffer,
                headerMime: spRes.headers.get("content-type") ?? undefined,
                filePath: name,
              });
              const originalFilename = params.preserveFilenames ? name : undefined;
              const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(
                buffer,
                mime ?? "application/octet-stream",
                "inbound",
                params.maxBytes,
                originalFilename,
              );
              sharePointMedia.push({
                path: saved.path,
                contentType: saved.contentType,
                placeholder: inferPlaceholder({ contentType: saved.contentType, fileName: name }),
              });
              downloadedReferenceUrls.add(shareUrl);
            }
          }
        } catch {
          // Ignore SharePoint download failures.
        }
      }
    }
  } catch {
    // Ignore message fetch failures.
  }

  const hosted = await downloadGraphHostedContent({
    accessToken,
    messageUrl,
    maxBytes: params.maxBytes,
    fetchFn: params.fetchFn,
    preserveFilenames: params.preserveFilenames,
  });

  const attachments = await fetchGraphCollection<GraphAttachment>({
    url: `${messageUrl}/attachments`,
    accessToken,
    fetchFn: params.fetchFn,
  });

  const normalizedAttachments = attachments.items.map(normalizeGraphAttachment);
  const filteredAttachments =
    sharePointMedia.length > 0
      ? normalizedAttachments.filter((att) => {
          const contentType = att.contentType?.toLowerCase();
          if (contentType !== "reference") return true;
          const url = typeof att.contentUrl === "string" ? att.contentUrl : "";
          if (!url) return true;
          return !downloadedReferenceUrls.has(url);
        })
      : normalizedAttachments;
  const attachmentMedia = await downloadMSTeamsAttachments({
    attachments: filteredAttachments,
    maxBytes: params.maxBytes,
    tokenProvider: params.tokenProvider,
    allowHosts,
    fetchFn: params.fetchFn,
    preserveFilenames: params.preserveFilenames,
  });

  return {
    media: [...sharePointMedia, ...hosted.media, ...attachmentMedia],
    hostedCount: hosted.count,
    attachmentCount: filteredAttachments.length + sharePointMedia.length,
    hostedStatus: hosted.status,
    attachmentStatus: attachments.status,
    messageUrl,
  };
}
