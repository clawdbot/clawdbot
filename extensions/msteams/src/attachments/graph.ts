// Msteams plugin module implements graph behavior.
import {
  readProviderJsonArrayFieldResponse,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
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
import { ensureUserAgentHeader } from "../user-agent.js";
import { downloadMSTeamsAttachments } from "./download.js";
import { downloadAndStoreMSTeamsRemoteMedia } from "./remote-media.js";
import {
  applyAuthorizationHeaderForUrl,
  encodeGraphShareId,
  GRAPH_ROOT,
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
} from "./shared.js";
import type {
  MSTeamsAccessTokenProvider,
  MSTeamsAttachmentLike,
  MSTeamsGraphMediaResult,
  MSTeamsInboundMedia,
} from "./types.js";

type GraphHostedContent = {
  id?: string | null;
  contentType?: string | null;
};

function createGraphHostedContentFact(item: GraphHostedContent): MSTeamsInboundMedia {
  const contentType = normalizeContentType(item.contentType);
  return {
    kind: resolveMSTeamsMediaKind({ contentType }),
    ...(contentType ? { contentType } : {}),
    ...(item.id ? { sourceId: item.id } : {}),
  };
}

type GraphAttachment = {
  id?: string | null;
  contentType?: string | null;
  contentUrl?: string | null;
  name?: string | null;
  thumbnailUrl?: string | null;
  content?: unknown;
};

export function buildMSTeamsGraphMessageUrl(params: {
  conversationType?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  threadRootMessageId?: string | null;
  teamAadGroupId?: string | null;
  channelId?: string | null;
}): string | undefined {
  const conversationType = normalizeLowercaseStringOrEmpty(params.conversationType ?? "");
  const messageId = normalizeOptionalString(params.messageId);
  if (!messageId) {
    return undefined;
  }

  if (conversationType === "channel") {
    const teamAadGroupId = normalizeOptionalString(params.teamAadGroupId);
    const channelId = normalizeOptionalString(params.channelId);
    if (!teamAadGroupId || !channelId) {
      return undefined;
    }
    const messageRoot = `${GRAPH_ROOT}/teams/${encodeURIComponent(teamAadGroupId)}/channels/${encodeURIComponent(channelId)}/messages`;
    const threadRootMessageId = normalizeOptionalString(params.threadRootMessageId);
    // Graph addresses replies only beneath the thread root. A bare reply ID is
    // not a top-level message, while fetching the root would attach the wrong file.
    return threadRootMessageId && threadRootMessageId !== messageId
      ? `${messageRoot}/${encodeURIComponent(threadRootMessageId)}/replies/${encodeURIComponent(messageId)}`
      : `${messageRoot}/${encodeURIComponent(messageId)}`;
  }

  const chatId = normalizeOptionalString(params.conversationId);
  if (!chatId) {
    return undefined;
  }
  return `${GRAPH_ROOT}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`;
}

async function fetchGraphCollection(params: {
  url: string;
  accessToken: string;
  fetchFn?: typeof fetch;
  ssrfPolicy?: SsrFPolicy;
  deadline?: MSTeamsRequestDeadline;
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
    timeoutMs: resolveMSTeamsRequestTimeoutMs(params.deadline),
  });
  try {
    const status = response.status;
    if (!response.ok) {
      return { status, items: [] };
    }
    try {
      const items = await readProviderJsonArrayFieldResponse(
        response,
        "MS Teams Graph collection",
        "value",
      );
      return { status, items };
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
    id: att.id ?? undefined,
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
  deadline?: MSTeamsRequestDeadline;
}): Promise<{ media: MSTeamsInboundMedia[]; status?: number; count: number }> {
  let hosted: { status: number; items: GraphHostedContent[] };
  try {
    hosted = (await fetchGraphCollection({
      url: `${params.messageUrl}/hostedContents`,
      accessToken: params.accessToken,
      fetchFn: params.fetchFn,
      ssrfPolicy: params.ssrfPolicy,
      deadline: params.deadline,
    })) as { status: number; items: GraphHostedContent[] };
  } catch (err) {
    params.logger?.warn?.("msteams graph hostedContents fetch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { media: [], count: 0 };
  }
  if (hosted.items.length === 0) {
    return { media: [], status: hosted.status, count: 0 };
  }

  const out: MSTeamsInboundMedia[] = [];
  for (const item of hosted.items) {
    if (!item.id) {
      out.push(createGraphHostedContentFact(item));
      continue;
    }

    // Graph's list API returns metadata only; hosted bytes live at `$value`.
    // Keep the JSON cap independent from the configured binary media limit.
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
        timeoutMs: resolveMSTeamsRequestTimeoutMs(params.deadline),
      });
      try {
        if (!valRes.ok) {
          out.push(createGraphHostedContentFact(item));
          continue;
        }
        const saved = await getMSTeamsRuntime().channel.media.saveResponseMedia(valRes, {
          sourceUrl: valueUrl,
          maxBytes: params.maxBytes,
          fallbackContentType: item.contentType ?? undefined,
          subdir: "inbound",
        });
        out.push({
          path: saved.path,
          contentType: saved.contentType,
          kind: resolveMSTeamsMediaKind({ contentType: saved.contentType }),
          sourceId: item.id,
        });
      } finally {
        await release();
      }
    } catch (err) {
      out.push(createGraphHostedContentFact(item));
      params.logger?.warn?.("msteams graph hostedContent value fetch failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
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
  fetchFnSupportsDispatcher?: boolean;
  resolveFn?: MSTeamsAttachmentResolveFn;
  deadline?: MSTeamsRequestDeadline;
  /** When true, embeds original filename in stored path for later extraction. */
  preserveFilenames?: boolean;
  /** Optional logger used to surface Graph/SharePoint fetch errors. */
  logger?: MSTeamsAttachmentDownloadLogger;
}): Promise<MSTeamsGraphMediaResult> {
  if (!params.messageUrl || !params.tokenProvider) {
    return { media: [] };
  }
  const tokenProvider = params.tokenProvider;
  const policy: MSTeamsAttachmentFetchPolicy = resolveAttachmentFetchPolicy({
    allowHosts: params.allowHosts,
    authAllowHosts: params.authAllowHosts,
  });
  const ssrfPolicy = resolveMediaSsrfPolicy(policy.allowHosts);
  const messageUrl = params.messageUrl;
  let accessToken: string;
  try {
    accessToken = await withMSTeamsRequestDeadline({
      deadline: params.deadline,
      label: "MS Teams Graph media token",
      work: () => tokenProvider.getAccessToken("https://graph.microsoft.com"),
    });
  } catch (err) {
    params.logger?.debug?.("graph media token acquisition failed", {
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
  let referenceAttachments: GraphAttachment[] = [];
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
      timeoutMs: resolveMSTeamsRequestTimeoutMs(params.deadline),
    });
    try {
      messageStatus = msgRes.status;
      if (msgRes.ok) {
        let msgData: {
          body?: { content?: string; contentType?: string };
          attachments?: GraphAttachment[];
        };
        try {
          msgData = await readProviderJsonResponse<typeof msgData>(
            msgRes,
            "MS Teams Graph message",
          );
        } catch (err) {
          params.logger?.debug?.("graph media message parse failed", {
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

        referenceAttachments = messageAttachments.filter(
          (a) => a.contentType === "reference" && a.contentUrl && a.name,
        );
      } else {
        params.logger?.debug?.("graph media message fetch not ok", {
          messageUrl,
          status: messageStatus,
        });
      }
    } finally {
      await release();
    }
  } catch (err) {
    params.logger?.debug?.("graph media message fetch failed", {
      messageUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    params.logger?.warn?.("msteams graph message fetch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // The message response owns a pinned dispatcher. Release it before nested
  // SharePoint requests so one metadata connection never spans child downloads.
  for (const att of referenceAttachments) {
    const name = att.name ?? "file";
    const shareUrl = att.contentUrl ?? "";
    const sourceId = att.id?.trim();
    const unavailableMedia: MSTeamsInboundMedia = {
      kind: resolveMSTeamsMediaKind({
        contentType: att.contentType ?? undefined,
        fileName: name,
      }),
      ...(sourceId ? { sourceId } : {}),
    };
    if (!shareUrl) {
      sharePointMedia.push(unavailableMedia);
      continue;
    }

    // This pass owns reference attachments even when their download fails; the
    // generic attachment pass must not emit a second unavailable fact.
    downloadedReferenceUrls.add(shareUrl);
    try {
      const sharesUrl = `${GRAPH_ROOT}/shares/${encodeGraphShareId(shareUrl)}/driveItem/content`;
      if (!isUrlAllowed(sharesUrl, policy.allowHosts)) {
        params.logger?.debug?.("graph media sharepoint url not in allowHosts", {
          messageUrl,
          sharesUrl,
        });
        sharePointMedia.push(unavailableMedia);
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
            fetchFnSupportsDispatcher: params.fetchFnSupportsDispatcher,
            requestInit: {
              ...init,
              headers,
            },
            resolveFn: params.resolveFn,
            timeoutMs: resolveMSTeamsRequestTimeoutMs(params.deadline),
          });
        },
      });
      sharePointMedia.push(sourceId ? { ...media, sourceId } : media);
    } catch (err) {
      sharePointMedia.push(unavailableMedia);
      params.logger?.warn?.("msteams SharePoint reference download failed", {
        error: err instanceof Error ? err.message : String(err),
        name,
      });
    }
  }

  const hosted = await downloadGraphHostedContent({
    accessToken,
    messageUrl,
    maxBytes: params.maxBytes,
    fetchFn: params.fetchFn,
    preserveFilenames: params.preserveFilenames,
    ssrfPolicy,
    logger: params.logger,
    deadline: params.deadline,
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
      fetchFnSupportsDispatcher: params.fetchFnSupportsDispatcher,
      resolveFn: params.resolveFn,
      deadline: params.deadline,
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
