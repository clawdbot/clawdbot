import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { getMSTeamsRuntime } from "../runtime.js";
import { ensureUserAgentHeader } from "../user-agent.js";
import { downloadMSTeamsAttachments } from "./download.js";
import { downloadAndStoreMSTeamsRemoteMedia } from "./remote-media.js";
import {
  applyAuthorizationHeaderForUrl,
  encodeGraphShareId,
  GRAPH_ROOT,
  estimateBase64DecodedBytes,
  inferPlaceholder,
  readNestedString,
  isUrlAllowed,
  type MSTeamsAttachmentDownloadLogger,
  type MSTeamsAttachmentFetchPolicy,
  type MSTeamsAttachmentResolveFn,
  normalizeContentType,
  resolveMediaSsrfPolicy,
  resolveAttachmentFetchPolicy,
  resolveRequestUrl,
  safeFetchWithPolicy,
} from "./shared.js";
import type {
  MSTeamsAccessTokenProvider,
  MSTeamsAttachmentLike,
  MSTeamsGraphMediaLogger,
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

export function buildMSTeamsGraphMessageUrls(params: {
  conversationType?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  replyToId?: string | null;
  conversationMessageId?: string | null;
  channelData?: unknown;
}): string[] {
  const conversationType = normalizeLowercaseStringOrEmpty(params.conversationType ?? "");
  const messageIdCandidates = new Set<string>();
  const pushCandidate = (value: string | null | undefined) => {
    const trimmed = normalizeOptionalString(value) ?? "";
    if (trimmed) {
      messageIdCandidates.add(trimmed);
    }
  };

  pushCandidate(params.messageId);
  pushCandidate(params.conversationMessageId);
  pushCandidate(readNestedString(params.channelData, ["messageId"]));
  pushCandidate(readNestedString(params.channelData, ["teamsMessageId"]));

  const replyToId = normalizeOptionalString(params.replyToId) ?? "";

  if (conversationType === "channel") {
    const teamId =
      readNestedString(params.channelData, ["team", "id"]) ??
      readNestedString(params.channelData, ["teamId"]);
    const channelId =
      readNestedString(params.channelData, ["channel", "id"]) ??
      readNestedString(params.channelData, ["channelId"]) ??
      readNestedString(params.channelData, ["teamsChannelId"]);
    if (!teamId || !channelId) {
      return [];
    }
    const urls: string[] = [];
    if (replyToId) {
      for (const candidate of messageIdCandidates) {
        if (candidate === replyToId) {
          continue;
        }
        urls.push(
          `${GRAPH_ROOT}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(replyToId)}/replies/${encodeURIComponent(candidate)}`,
        );
      }
    }
    if (messageIdCandidates.size === 0 && replyToId) {
      messageIdCandidates.add(replyToId);
    }
    for (const candidate of messageIdCandidates) {
      urls.push(
        `${GRAPH_ROOT}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(candidate)}`,
      );
    }
    return Array.from(new Set(urls));
  }

  const chatId = params.conversationId?.trim() || readNestedString(params.channelData, ["chatId"]);
  if (!chatId) {
    return [];
  }
  if (messageIdCandidates.size === 0 && replyToId) {
    messageIdCandidates.add(replyToId);
  }
  const urls = Array.from(messageIdCandidates).map(
    (candidate) =>
      `${GRAPH_ROOT}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(candidate)}`,
  );
  return Array.from(new Set(urls));
}

async function fetchGraphCollection(params: {
  url: string;
  accessToken: string;
  fetchFn?: typeof fetch;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{ status: number; items: unknown[] }> {
  const fetchFn = params.fetchFn ?? fetch;
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    fetchImpl: fetchFn,
    init: {
      headers: ensureUserAgentHeader({ Authorization: `Bearer ${params.accessToken}` }),
    },
    policy: params.ssrfPolicy,
    auditContext: "msteams.graph.collection",
  });
  try {
    const status = response.status;
    if (!response.ok) {
      return { status, items: [] };
    }
    try {
      const data = (await response.json()) as { value?: unknown[] };
      return { status, items: Array.isArray(data.value) ? data.value : [] };
    } catch {
      return { status, items: [] };
    }
  } finally {
    await release();
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
  ssrfPolicy?: SsrFPolicy;
  logger?: MSTeamsAttachmentDownloadLogger;
}): Promise<{ media: MSTeamsInboundMedia[]; status: number; count: number }> {
  const hosted = (await fetchGraphCollection({
    url: `${params.messageUrl}/hostedContents`,
    accessToken: params.accessToken,
    fetchFn: params.fetchFn,
    ssrfPolicy: params.ssrfPolicy,
  })) as { status: number; items: GraphHostedContent[] };
  if (hosted.items.length === 0) {
    return { media: [], status: hosted.status, count: 0 };
  }

  const out: MSTeamsInboundMedia[] = [];
  for (const item of hosted.items) {
    const contentBytes = typeof item.contentBytes === "string" ? item.contentBytes : "";
    let buffer: Buffer;
    if (contentBytes) {
      if (estimateBase64DecodedBytes(contentBytes) > params.maxBytes) {
        continue;
      }
      try {
        buffer = Buffer.from(contentBytes, "base64");
      } catch (err) {
        params.logger?.warn?.("msteams graph hostedContent base64 decode failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    } else if (item.id) {
      // contentBytes not inline — fetch from the individual $value endpoint.
      try {
        const valueUrl = `${params.messageUrl}/hostedContents/${encodeURIComponent(item.id)}/$value`;
        const { response: valRes, release } = await fetchWithSsrFGuard({
          url: valueUrl,
          fetchImpl: params.fetchFn ?? fetch,
          init: {
            headers: ensureUserAgentHeader({ Authorization: `Bearer ${params.accessToken}` }),
          },
          policy: params.ssrfPolicy,
          auditContext: "msteams.graph.hostedContent.value",
        });
        try {
          if (!valRes.ok) {
            continue;
          }
          // Check Content-Length before buffering to avoid RSS spikes on large files.
          const cl = valRes.headers.get("content-length");
          if (cl && Number(cl) > params.maxBytes) {
            continue;
          }
          const ab = await valRes.arrayBuffer();
          buffer = Buffer.from(ab);
        } finally {
          await release();
        }
      } catch (err) {
        params.logger?.warn?.("msteams graph hostedContent value fetch failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    } else {
      continue;
    }
    if (buffer.byteLength > params.maxBytes) {
      continue;
    }
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
    } catch (err) {
      params.logger?.warn?.("msteams graph hostedContent save failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { media: out, status: hosted.status, count: hosted.items.length };
}

export async function downloadMSTeamsGraphMedia(params: {
  messageUrl?: string | null;
  tokenProvider?: MSTeamsAccessTokenProvider;
  maxBytes: number;
  allowHosts?: string[];
  authAllowHosts?: string[];
  fetchFn?: typeof fetch;
  resolveFn?: MSTeamsAttachmentResolveFn;
  /** When true, embeds original filename in stored path for later extraction. */
  preserveFilenames?: boolean;
  /** Optional logger used to surface Graph/SharePoint fetch errors. */
  logger?: MSTeamsAttachmentDownloadLogger;
  /** Back-compat diagnostic logger used by older tests/callers. */
  log?: MSTeamsGraphMediaLogger;
}): Promise<MSTeamsGraphMediaResult> {
  if (!params.messageUrl || !params.tokenProvider) {
    return { media: [] };
  }
  const policy: MSTeamsAttachmentFetchPolicy = resolveAttachmentFetchPolicy({
    allowHosts: params.allowHosts,
    authAllowHosts: params.authAllowHosts,
  });
  const ssrfPolicy = resolveMediaSsrfPolicy(policy.allowHosts);
  const messageUrl = params.messageUrl;
  const debugLog =
    params.log ?? (params.logger as MSTeamsGraphMediaLogger | undefined) ?? undefined;
  let accessToken: string;
  try {
    accessToken = await params.tokenProvider.getAccessToken("https://graph.microsoft.com");
  } catch (err) {
    debugLog?.debug?.("graph media token acquisition failed", {
      messageUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    params.logger?.warn?.("msteams graph token acquisition failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { media: [], messageUrl, tokenError: true };
  }

  const fetchFn = params.fetchFn ?? fetch;
  const sharePointMedia: MSTeamsInboundMedia[] = [];
  const downloadedReferenceUrls = new Set<string>();
  let messageAttachments: GraphAttachment[] = [];
  let messageStatus: number | undefined;
  try {
    const { response: msgRes, release } = await fetchWithSsrFGuard({
      url: messageUrl,
      fetchImpl: fetchFn,
      init: {
        headers: ensureUserAgentHeader({ Authorization: `Bearer ${accessToken}` }),
      },
      policy: ssrfPolicy,
      auditContext: "msteams.graph.message",
    });
    try {
      messageStatus = msgRes.status;
      if (msgRes.ok) {
        let msgData: {
          body?: { content?: string; contentType?: string };
          attachments?: GraphAttachment[];
        };
        try {
          msgData = (await msgRes.json()) as typeof msgData;
        } catch (err) {
          debugLog?.debug?.("graph media message parse failed", {
            messageUrl,
            error: err instanceof Error ? err.message : String(err),
          });
          params.logger?.warn?.("msteams graph message parse failed", {
            error: err instanceof Error ? err.message : String(err),
            messageUrl,
          });
          msgData = {};
        }
        messageAttachments = Array.isArray(msgData.attachments) ? msgData.attachments : [];

        const spAttachments = messageAttachments.filter(
          (a) => a.contentType === "reference" && a.contentUrl && a.name,
        );
        for (const att of spAttachments) {
          const name = att.name ?? "file";
          const shareUrl = att.contentUrl ?? "";
          if (!shareUrl) {
            continue;
          }

          try {
            const sharesUrl = `${GRAPH_ROOT}/shares/${encodeGraphShareId(shareUrl)}/driveItem/content`;
            if (!isUrlAllowed(sharesUrl, policy.allowHosts)) {
              debugLog?.debug?.("graph media sharepoint url not in allowHosts", {
                messageUrl,
                sharesUrl,
              });
              continue;
            }

            const media = await downloadAndStoreMSTeamsRemoteMedia({
              url: sharesUrl,
              filePathHint: name,
              maxBytes: params.maxBytes,
              contentTypeHint: "application/octet-stream",
              preserveFilenames: params.preserveFilenames,
              ssrfPolicy,
              useDirectFetch: true,
              fetchImpl: async (input, init) => {
                const requestUrl = resolveRequestUrl(input);
                const headers = ensureUserAgentHeader(init?.headers);
                applyAuthorizationHeaderForUrl({
                  headers,
                  url: requestUrl,
                  authAllowHosts: policy.authAllowHosts,
                  bearerToken: accessToken,
                });
                return await safeFetchWithPolicy({
                  url: requestUrl,
                  policy,
                  fetchFn,
                  requestInit: {
                    ...init,
                    headers,
                  },
                  resolveFn: params.resolveFn,
                });
              },
            });
            sharePointMedia.push(media);
            downloadedReferenceUrls.add(shareUrl);
          } catch (err) {
            params.logger?.warn?.("msteams SharePoint reference download failed", {
              error: err instanceof Error ? err.message : String(err),
              name,
            });
          }
        }
      } else {
        debugLog?.debug?.("graph media message fetch not ok", {
          messageUrl,
          status: messageStatus,
        });
      }
    } finally {
      await release();
    }
  } catch (err) {
    debugLog?.debug?.("graph media message fetch failed", {
      messageUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    params.logger?.warn?.("msteams graph message fetch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const hosted = await downloadGraphHostedContent({
    accessToken,
    messageUrl,
    maxBytes: params.maxBytes,
    fetchFn: params.fetchFn,
    preserveFilenames: params.preserveFilenames,
    ssrfPolicy,
    logger: params.logger,
  });

  const normalizedAttachments = messageAttachments.map(normalizeGraphAttachment);
  const filteredAttachments =
    sharePointMedia.length > 0
      ? normalizedAttachments.filter((att) => {
          const contentType = normalizeOptionalLowercaseString(att.contentType);
          if (contentType !== "reference") {
            return true;
          }
          const url = typeof att.contentUrl === "string" ? att.contentUrl : "";
          if (!url) {
            return true;
          }
          return !downloadedReferenceUrls.has(url);
        })
      : normalizedAttachments;
  let attachmentMedia: MSTeamsInboundMedia[] = [];
  try {
    attachmentMedia = await downloadMSTeamsAttachments({
      attachments: filteredAttachments,
      maxBytes: params.maxBytes,
      tokenProvider: params.tokenProvider,
      allowHosts: policy.allowHosts,
      authAllowHosts: policy.authAllowHosts,
      fetchFn: params.fetchFn,
      resolveFn: params.resolveFn,
      preserveFilenames: params.preserveFilenames,
      logger: params.logger,
    });
  } catch (err) {
    params.logger?.warn?.("msteams graph attachment download failed", {
      error: err instanceof Error ? err.message : String(err),
      messageUrl,
    });
  }

  return {
    media: [...sharePointMedia, ...hosted.media, ...attachmentMedia],
    hostedCount: hosted.count,
    attachmentCount: filteredAttachments.length + sharePointMedia.length,
    hostedStatus: hosted.status,
    attachmentStatus: messageStatus,
    messageUrl,
  };
}
