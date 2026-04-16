import { Buffer } from "node:buffer";
import { getMSTeamsRuntime } from "../runtime.js";
import { ensureUserAgentHeader } from "../user-agent.js";
import {
  inferPlaceholder,
  isUrlAllowed,
  type MSTeamsAttachmentDownloadLogger,
  type MSTeamsAttachmentFetchPolicy,
  type MSTeamsAttachmentResolveFn,
  resolveAttachmentFetchPolicy,
  safeFetchWithPolicy,
} from "./shared.js";
import type {
  MSTeamsAccessTokenProvider,
  MSTeamsGraphMediaResult,
  MSTeamsInboundMedia,
} from "./types.js";

/**
 * Bot Framework Service token scope for requesting a token used against
 * the Bot Connector (v3) REST endpoints such as `/v3/attachments/{id}`.
 */
const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com";

/**
 * Detect Bot Framework personal chat ("a:") and MSA orgid ("8:orgid:") conversation
 * IDs. These identifiers are not recognized by Graph's `/chats/{id}` endpoint, so we
 * must fetch media via the Bot Framework v3 attachments endpoint instead.
 *
 * Graph-compatible IDs start with `19:` and are left untouched by this detector.
 */
export function isBotFrameworkPersonalChatId(conversationId: string | null | undefined): boolean {
  if (typeof conversationId !== "string") {
    return false;
  }
  const trimmed = conversationId.trim();
  return trimmed.startsWith("a:") || trimmed.startsWith("8:orgid:");
}

type BotFrameworkView = {
  viewId?: string | null;
  size?: number | null;
};

type BotFrameworkAttachmentInfo = {
  name?: string | null;
  type?: string | null;
  views?: BotFrameworkView[] | null;
};

function normalizeServiceUrl(serviceUrl: string): string {
  // Bot Framework service URLs sometimes carry a trailing slash; normalize so
  // we can safely append `/v3/attachments/...` below.
  return serviceUrl.replace(/\/+$/, "");
}

async function fetchBotFrameworkAttachmentInfo(params: {
  serviceUrl: string;
  attachmentId: string;
  accessToken: string;
  policy: MSTeamsAttachmentFetchPolicy;
  fetchFn?: typeof fetch;
  resolveFn?: MSTeamsAttachmentResolveFn;
  logger?: MSTeamsAttachmentDownloadLogger;
}): Promise<BotFrameworkAttachmentInfo | undefined> {
  const url = `${normalizeServiceUrl(params.serviceUrl)}/v3/attachments/${encodeURIComponent(params.attachmentId)}`;
  // Use `safeFetchWithPolicy` instead of `fetchWithSsrFGuard`. The strict
  // pinned undici dispatcher used by `fetchWithSsrFGuard` is incompatible
  // with Node 24+'s built-in undici v7 and silently breaks Bot Framework
  // attachment downloads (same root cause as the SharePoint fix in #63396).
  // `safeFetchWithPolicy` already enforces hostname allowlist validation
  // across every redirect hop, which is sufficient for these attachment
  // service URLs.
  let response: Response;
  try {
    response = await safeFetchWithPolicy({
      url,
      policy: params.policy,
      fetchFn: params.fetchFn,
      resolveFn: params.resolveFn,
      requestInit: {
        headers: ensureUserAgentHeader({ Authorization: `Bearer ${params.accessToken}` }),
      },
    });
  } catch (err) {
    params.logger?.warn?.("msteams botFramework attachmentInfo fetch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  if (!response.ok) {
    params.logger?.warn?.("msteams botFramework attachmentInfo non-ok", {
      status: response.status,
    });
    return undefined;
  }
  try {
    return (await response.json()) as BotFrameworkAttachmentInfo;
  } catch (err) {
    params.logger?.warn?.("msteams botFramework attachmentInfo parse failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

async function fetchBotFrameworkAttachmentView(params: {
  serviceUrl: string;
  attachmentId: string;
  viewId: string;
  accessToken: string;
  maxBytes: number;
  policy: MSTeamsAttachmentFetchPolicy;
  fetchFn?: typeof fetch;
  resolveFn?: MSTeamsAttachmentResolveFn;
  logger?: MSTeamsAttachmentDownloadLogger;
}): Promise<Buffer | undefined> {
  const url = `${normalizeServiceUrl(params.serviceUrl)}/v3/attachments/${encodeURIComponent(params.attachmentId)}/views/${encodeURIComponent(params.viewId)}`;
  // See `fetchBotFrameworkAttachmentInfo` for why this uses
  // `safeFetchWithPolicy` instead of `fetchWithSsrFGuard` on Node 24+ (#63396).
  let response: Response;
  try {
    response = await safeFetchWithPolicy({
      url,
      policy: params.policy,
      fetchFn: params.fetchFn,
      resolveFn: params.resolveFn,
      requestInit: {
        headers: ensureUserAgentHeader({ Authorization: `Bearer ${params.accessToken}` }),
      },
    });
  } catch (err) {
    params.logger?.warn?.("msteams botFramework attachmentView fetch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  if (!response.ok) {
    params.logger?.warn?.("msteams botFramework attachmentView non-ok", {
      status: response.status,
    });
    return undefined;
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > params.maxBytes) {
    return undefined;
  }
  try {
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.byteLength > params.maxBytes) {
      return undefined;
    }
    return buffer;
  } catch (err) {
    params.logger?.warn?.("msteams botFramework attachmentView body read failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Download media for a single attachment via the Bot Framework v3 attachments
 * endpoint. Used for personal DM conversations where the Graph `/chats/{id}`
 * path is not usable because the Bot Framework conversation ID (`a:...`) is
 * not a valid Graph chat identifier.
 */
export async function downloadMSTeamsBotFrameworkAttachment(params: {
  serviceUrl: string;
  attachmentId: string;
  tokenProvider?: MSTeamsAccessTokenProvider;
  maxBytes: number;
  allowHosts?: string[];
  authAllowHosts?: string[];
  fetchFn?: typeof fetch;
  resolveFn?: MSTeamsAttachmentResolveFn;
  fileNameHint?: string | null;
  contentTypeHint?: string | null;
  preserveFilenames?: boolean;
  logger?: MSTeamsAttachmentDownloadLogger;
}): Promise<MSTeamsInboundMedia | undefined> {
  if (!params.serviceUrl || !params.attachmentId || !params.tokenProvider) {
    return undefined;
  }
  const policy: MSTeamsAttachmentFetchPolicy = resolveAttachmentFetchPolicy({
    allowHosts: params.allowHosts,
    authAllowHosts: params.authAllowHosts,
  });
  const baseUrl = `${normalizeServiceUrl(params.serviceUrl)}/v3/attachments/${encodeURIComponent(params.attachmentId)}`;
  if (!isUrlAllowed(baseUrl, policy.allowHosts)) {
    return undefined;
  }

  let accessToken: string;
  try {
    accessToken = await params.tokenProvider.getAccessToken(BOT_FRAMEWORK_SCOPE);
  } catch (err) {
    params.logger?.warn?.("msteams botFramework token acquisition failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  if (!accessToken) {
    return undefined;
  }

  const info = await fetchBotFrameworkAttachmentInfo({
    serviceUrl: params.serviceUrl,
    attachmentId: params.attachmentId,
    accessToken,
    policy,
    fetchFn: params.fetchFn,
    resolveFn: params.resolveFn,
    logger: params.logger,
  });
  if (!info) {
    return undefined;
  }

  const views = Array.isArray(info.views) ? info.views : [];
  // Prefer the "original" view when present, otherwise fall back to the first
  // view the Bot Framework service returned.
  const original = views.find((view) => view?.viewId === "original");
  const candidateView = original ?? views.find((view) => typeof view?.viewId === "string");
  const viewId =
    typeof candidateView?.viewId === "string" && candidateView.viewId
      ? candidateView.viewId
      : undefined;
  if (!viewId) {
    return undefined;
  }
  if (
    typeof candidateView?.size === "number" &&
    candidateView.size > 0 &&
    candidateView.size > params.maxBytes
  ) {
    return undefined;
  }

  const buffer = await fetchBotFrameworkAttachmentView({
    serviceUrl: params.serviceUrl,
    attachmentId: params.attachmentId,
    viewId,
    accessToken,
    maxBytes: params.maxBytes,
    policy,
    fetchFn: params.fetchFn,
    resolveFn: params.resolveFn,
    logger: params.logger,
  });
  if (!buffer) {
    return undefined;
  }

  const fileNameHint =
    (typeof params.fileNameHint === "string" && params.fileNameHint) ||
    (typeof info.name === "string" && info.name) ||
    undefined;
  const contentTypeHint =
    (typeof params.contentTypeHint === "string" && params.contentTypeHint) ||
    (typeof info.type === "string" && info.type) ||
    undefined;

  const mime = await getMSTeamsRuntime().media.detectMime({
    buffer,
    headerMime: contentTypeHint,
    filePath: fileNameHint,
  });

  try {
    const originalFilename = params.preserveFilenames ? fileNameHint : undefined;
    const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(
      buffer,
      mime ?? contentTypeHint,
      "inbound",
      params.maxBytes,
      originalFilename,
    );
    return {
      path: saved.path,
      contentType: saved.contentType,
      placeholder: inferPlaceholder({ contentType: saved.contentType, fileName: fileNameHint }),
    };
  } catch (err) {
    params.logger?.warn?.("msteams botFramework save failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Download media for every attachment referenced by a Bot Framework personal
 * chat activity. Returns all successfully fetched media along with diagnostics
 * compatible with `downloadMSTeamsGraphMedia`'s result shape so callers can
 * reuse the existing logging path.
 */
export async function downloadMSTeamsBotFrameworkAttachments(params: {
  serviceUrl: string;
  attachmentIds: string[];
  tokenProvider?: MSTeamsAccessTokenProvider;
  maxBytes: number;
  allowHosts?: string[];
  authAllowHosts?: string[];
  fetchFn?: typeof fetch;
  resolveFn?: MSTeamsAttachmentResolveFn;
  fileNameHint?: string | null;
  contentTypeHint?: string | null;
  preserveFilenames?: boolean;
  logger?: MSTeamsAttachmentDownloadLogger;
}): Promise<MSTeamsGraphMediaResult> {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of params.attachmentIds ?? []) {
    if (typeof id !== "string") {
      continue;
    }
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  if (unique.length === 0 || !params.serviceUrl || !params.tokenProvider) {
    return { media: [], attachmentCount: unique.length };
  }

  const media: MSTeamsInboundMedia[] = [];
  for (const attachmentId of unique) {
    try {
      const item = await downloadMSTeamsBotFrameworkAttachment({
        serviceUrl: params.serviceUrl,
        attachmentId,
        tokenProvider: params.tokenProvider,
        maxBytes: params.maxBytes,
        allowHosts: params.allowHosts,
        authAllowHosts: params.authAllowHosts,
        fetchFn: params.fetchFn,
        resolveFn: params.resolveFn,
        fileNameHint: params.fileNameHint,
        contentTypeHint: params.contentTypeHint,
        preserveFilenames: params.preserveFilenames,
        logger: params.logger,
      });
      if (item) {
        media.push(item);
      }
    } catch (err) {
      params.logger?.warn?.("msteams botFramework attachment download failed", {
        error: err instanceof Error ? err.message : String(err),
        attachmentId,
      });
    }
  }

  return {
    media,
    attachmentCount: unique.length,
  };
}
