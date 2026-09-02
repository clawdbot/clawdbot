import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/account-helpers";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { sanitizeUntrustedFileName } from "openclaw/plugin-sdk/security-runtime";
import { ssrfPolicyFromPrivateNetworkOptIn } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { fetchWithSsrFGuard, type OpenClawConfig, type PluginRuntime } from "../runtime-api.js";
import { resolveNextcloudTalkApiCredentials } from "./api-credentials.js";
import { releaseNextcloudTalkGuardedResponse } from "./guarded-response.js";
import { normalizeNextcloudTalkAllowEntry, resolveNextcloudTalkAllowlistMatch } from "./policy.js";
import type { NextcloudTalkAccountConfig, NextcloudTalkInboundAttachment } from "./types.js";

const DEFAULT_NEXTCLOUD_TALK_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const NEXTCLOUD_TALK_MEDIA_RESPONSE_HEADER_TIMEOUT_MS = 120_000;
const NEXTCLOUD_TALK_MEDIA_READ_IDLE_TIMEOUT_MS = 30_000;

export type NextcloudTalkMediaOutcomeReason =
  | "media_sender_not_allowlisted"
  | "media_hidden_download"
  | "media_missing_metadata"
  | "media_invalid_link"
  | "media_origin_mismatch"
  | "media_auth_unavailable"
  | "media_message_mismatch"
  | "media_declared_oversize"
  | "media_download_oversize"
  | "media_unavailable"
  | "media_unsupported"
  | "media_fetch_failed"
  | "media_stage_failed"
  | "media_cleanup_failed";

export type NextcloudTalkAttachmentReferenceResult =
  | { ok: true; origin: string; hostname: string; fileName: string }
  | { ok: false; reason: "media_invalid_link" | "media_origin_mismatch" };

export type NextcloudTalkAuthenticatedMediaSourceResult =
  | {
      ok: true;
      url: string;
      origin: string;
      hostname: string;
      fileName: string;
      authorization: string;
      contentTypeOverride?: string;
    }
  | {
      ok: false;
      reason:
        | "media_auth_unavailable"
        | "media_fetch_failed"
        | "media_message_mismatch"
        | "media_unavailable";
      status?: number;
    };

type NextcloudTalkGuardedFetch = typeof fetchWithSsrFGuard;

function boundedLogField(value: string): string {
  return value.replace(/[^a-z0-9._:/-]/giu, "_").slice(0, 128) || "unknown";
}

export function isNextcloudTalkMediaSenderAllowed(params: {
  mediaAllowFrom: string[] | undefined;
  senderId: string;
}): boolean {
  return resolveNextcloudTalkAllowlistMatch({
    allowFrom: params.mediaAllowFrom,
    senderId: params.senderId,
  }).allowed;
}

export function resolveNextcloudTalkMediaMaxBytes(params: {
  cfg: OpenClawConfig;
  accountId: string;
  mediaMaxMb: number | undefined;
}): number {
  return (
    resolveChannelMediaMaxBytes({
      cfg: params.cfg,
      accountId: params.accountId,
      resolveChannelLimitMb: () => params.mediaMaxMb,
    }) ?? DEFAULT_NEXTCLOUD_TALK_MEDIA_MAX_BYTES
  );
}

export function resolveNextcloudTalkAttachmentReference(params: {
  baseUrl: string;
  shareUrl: string;
  fileName: string;
}): NextcloudTalkAttachmentReferenceResult {
  let base: URL;
  let share: URL;
  try {
    base = new URL(params.baseUrl);
    share = new URL(params.shareUrl);
  } catch {
    return { ok: false, reason: "media_invalid_link" };
  }
  const fileName = sanitizeUntrustedFileName(params.fileName, "");
  if (
    (base.protocol !== "http:" && base.protocol !== "https:") ||
    (share.protocol !== "http:" && share.protocol !== "https:") ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    share.username ||
    share.password ||
    share.search ||
    share.hash ||
    !fileName
  ) {
    return { ok: false, reason: "media_invalid_link" };
  }
  if (share.origin !== base.origin) {
    return { ok: false, reason: "media_origin_mismatch" };
  }

  const basePath = base.pathname.replace(/\/+$/u, "");
  const sharePrefix = `${basePath}/s/`;
  if (!share.pathname.startsWith(sharePrefix)) {
    return { ok: false, reason: "media_invalid_link" };
  }
  const shareToken = share.pathname.slice(sharePrefix.length);
  if (!shareToken || shareToken.includes("/")) {
    return { ok: false, reason: "media_invalid_link" };
  }

  return {
    ok: true,
    origin: base.origin,
    hostname: base.hostname,
    fileName,
  };
}

function buildBasicAuthorization(apiUser: string, apiPassword: string): string {
  return `Basic ${Buffer.from(`${apiUser}:${apiPassword}`, "utf8").toString("base64")}`;
}

function buildSameOriginUrl(base: URL, pathname: string): URL {
  const url = new URL(base.origin);
  url.pathname = `${base.pathname.replace(/\/+$/u, "")}${pathname}`;
  return url;
}

function resolveCanonicalUserId(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.ocs) || !isRecord(payload.ocs.data)) {
    return undefined;
  }
  const id = payload.ocs.data.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function parseHistorySize(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const normalized = String(value).trim();
  if (!/^\d+$/u.test(normalized)) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function resolveExactHistoryMedia(params: {
  payload: unknown;
  roomToken: string;
  messageId: string;
  senderId: string;
  attachment: NextcloudTalkInboundAttachment;
}): { encodedFilePath: string; contentTypeOverride?: string } | undefined {
  if (!isRecord(params.payload) || !isRecord(params.payload.ocs)) {
    return undefined;
  }
  const data = params.payload.ocs.data;
  if (!Array.isArray(data)) {
    return undefined;
  }
  const message = data.find(
    (candidate) => isRecord(candidate) && String(candidate.id) === params.messageId,
  );
  if (!isRecord(message) || message.token !== params.roomToken) {
    return undefined;
  }
  const actorType = typeof message.actorType === "string" ? message.actorType : "";
  const actorId = typeof message.actorId === "string" ? message.actorId : "";
  if (
    normalizeNextcloudTalkAllowEntry(`${actorType}/${actorId}`) !==
    normalizeNextcloudTalkAllowEntry(params.senderId)
  ) {
    return undefined;
  }
  if (!isRecord(message.messageParameters) || !isRecord(message.messageParameters.file)) {
    return undefined;
  }
  const file = message.messageParameters.file;
  const fileId =
    typeof file.id === "string"
      ? file.id.trim()
      : typeof file.id === "number" && Number.isSafeInteger(file.id)
        ? String(file.id)
        : "";
  const name = typeof file.name === "string" ? file.name.trim() : "";
  const mimeType = typeof file.mimetype === "string" ? file.mimetype.trim() : "";
  const path = typeof file.path === "string" ? file.path.trim() : "";
  const hideDownload = file["hide-download"];
  if (
    (params.attachment.fileId && fileId !== params.attachment.fileId) ||
    name !== params.attachment.name ||
    mimeType !== params.attachment.mimeType ||
    parseHistorySize(file.size) !== params.attachment.declaredSizeBytes ||
    hideDownload !== (params.attachment.hideDownload ? "yes" : "no") ||
    !path
  ) {
    return undefined;
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        !segment || segment === "." || segment === ".." || containsControlCharacter(segment),
    ) ||
    segments.at(-1) !== params.attachment.name
  ) {
    return undefined;
  }
  const encodedFilePath = segments.map((segment) => encodeURIComponent(segment)).join("/");
  const messageType = typeof message.messageType === "string" ? message.messageType : "";
  const contentTypeOverride =
    messageType === "voice-message" && /^video\//iu.test(mimeType)
      ? mimeType.replace(/^video\//iu, "audio/")
      : undefined;
  return {
    encodedFilePath,
    ...(contentTypeOverride ? { contentTypeOverride } : {}),
  };
}

async function fetchNextcloudTalkJson(params: {
  fetchGuarded: NextcloudTalkGuardedFetch;
  url: string;
  authorization: string;
  origin: string;
  hostname: string;
  accountConfig: NextcloudTalkAccountConfig;
  auditContext: string;
}): Promise<{ ok: true; payload: unknown } | { ok: false; status?: number }> {
  try {
    const privateNetworkPolicy = ssrfPolicyFromPrivateNetworkOptIn(params.accountConfig);
    const { response, release } = await params.fetchGuarded({
      url: params.url,
      init: {
        method: "GET",
        headers: {
          Authorization: params.authorization,
          "OCS-APIRequest": "true",
          Accept: "application/json",
        },
      },
      maxRedirects: 0,
      requireHttps: new URL(params.origin).protocol === "https:",
      timeoutMs: NEXTCLOUD_TALK_MEDIA_RESPONSE_HEADER_TIMEOUT_MS,
      policy: {
        ...privateNetworkPolicy,
        hostnameAllowlist: [params.hostname],
      },
      auditContext: params.auditContext,
    });
    try {
      if (!response.ok) {
        return { ok: false, status: response.status };
      }
      return {
        ok: true,
        payload: await readProviderJsonResponse<unknown>(response, "Nextcloud Talk media lookup", {
          maxBytes: 64 * 1024,
          chunkTimeoutMs: NEXTCLOUD_TALK_MEDIA_READ_IDLE_TIMEOUT_MS,
        }),
      };
    } finally {
      await releaseNextcloudTalkGuardedResponse({ response, release });
    }
  } catch {
    return { ok: false };
  }
}

export async function resolveNextcloudTalkAuthenticatedMediaSource(params: {
  baseUrl: string;
  roomToken: string;
  messageId: string;
  senderId: string;
  attachment: NextcloudTalkInboundAttachment;
  accountConfig: NextcloudTalkAccountConfig;
  reference: Extract<NextcloudTalkAttachmentReferenceResult, { ok: true }>;
  fetchGuarded?: NextcloudTalkGuardedFetch;
}): Promise<NextcloudTalkAuthenticatedMediaSourceResult> {
  const credentials = resolveNextcloudTalkApiCredentials({
    apiUser: params.accountConfig.apiUser,
    apiPassword: params.accountConfig.apiPassword,
    apiPasswordFile: params.accountConfig.apiPasswordFile,
  });
  if (!credentials) {
    return { ok: false, reason: "media_auth_unavailable" };
  }
  let base: URL;
  try {
    base = new URL(params.baseUrl);
  } catch {
    return { ok: false, reason: "media_fetch_failed" };
  }
  const authorization = buildBasicAuthorization(credentials.apiUser, credentials.apiPassword);
  const fetchGuarded = params.fetchGuarded ?? fetchWithSsrFGuard;
  const userUrl = buildSameOriginUrl(base, "/ocs/v1.php/cloud/user");
  userUrl.searchParams.set("format", "json");
  const user = await fetchNextcloudTalkJson({
    fetchGuarded,
    url: userUrl.toString(),
    authorization,
    origin: params.reference.origin,
    hostname: params.reference.hostname,
    accountConfig: params.accountConfig,
    auditContext: "nextcloud-talk.inbound-media-user",
  });
  if (!user.ok) {
    return {
      ok: false,
      reason:
        user.status === 401 || user.status === 403
          ? "media_auth_unavailable"
          : "media_fetch_failed",
      ...(user.status === undefined ? {} : { status: user.status }),
    };
  }
  const canonicalUserId = resolveCanonicalUserId(user.payload);
  if (!canonicalUserId) {
    return { ok: false, reason: "media_auth_unavailable" };
  }

  const historyUrl = buildSameOriginUrl(
    base,
    `/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(params.roomToken)}`,
  );
  historyUrl.searchParams.set("lookIntoFuture", "0");
  historyUrl.searchParams.set("limit", "1");
  historyUrl.searchParams.set("lastKnownMessageId", params.messageId);
  historyUrl.searchParams.set("includeLastKnown", "1");
  const history = await fetchNextcloudTalkJson({
    fetchGuarded,
    url: historyUrl.toString(),
    authorization,
    origin: params.reference.origin,
    hostname: params.reference.hostname,
    accountConfig: params.accountConfig,
    auditContext: "nextcloud-talk.inbound-media-message",
  });
  if (!history.ok) {
    return {
      ok: false,
      reason:
        history.status === 401 || history.status === 403
          ? "media_auth_unavailable"
          : history.status === 404
            ? "media_unavailable"
            : "media_fetch_failed",
      ...(history.status === undefined ? {} : { status: history.status }),
    };
  }
  const exactHistoryMedia = resolveExactHistoryMedia({
    payload: history.payload,
    roomToken: params.roomToken,
    messageId: params.messageId,
    senderId: params.senderId,
    attachment: params.attachment,
  });
  if (!exactHistoryMedia) {
    return { ok: false, reason: "media_message_mismatch" };
  }
  const webDavUrl = buildSameOriginUrl(
    base,
    `/remote.php/dav/files/${encodeURIComponent(canonicalUserId)}/${exactHistoryMedia.encodedFilePath}`,
  );
  return {
    ok: true,
    url: webDavUrl.toString(),
    origin: params.reference.origin,
    hostname: params.reference.hostname,
    fileName: params.reference.fileName,
    authorization,
    ...(exactHistoryMedia.contentTypeOverride
      ? { contentTypeOverride: exactHistoryMedia.contentTypeOverride }
      : {}),
  };
}

type NextcloudTalkSaveRemoteMedia = PluginRuntime["channel"]["media"]["saveRemoteMedia"];

export type NextcloudTalkMediaFailure = {
  reason: Extract<
    NextcloudTalkMediaOutcomeReason,
    "media_download_oversize" | "media_unavailable" | "media_fetch_failed" | "media_stage_failed"
  >;
  status?: number;
};

export function classifyNextcloudTalkMediaFailure(error: unknown): NextcloudTalkMediaFailure {
  if (!(error instanceof MediaFetchError)) {
    return { reason: "media_stage_failed" };
  }
  if (error.code === "max_bytes") {
    return { reason: "media_download_oversize" };
  }
  if (error.code === "http_error") {
    return {
      reason: "media_unavailable",
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }
  return { reason: "media_fetch_failed" };
}

export async function saveNextcloudTalkInboundMedia(params: {
  saveRemoteMedia: NextcloudTalkSaveRemoteMedia;
  url: string;
  origin: string;
  hostname: string;
  accountConfig: NextcloudTalkAccountConfig;
  maxBytes: number;
  fileName: string;
  mimeType: string;
  authorization: string;
}): Promise<Awaited<ReturnType<NextcloudTalkSaveRemoteMedia>>> {
  const originProtocol = new URL(params.origin).protocol;
  const privateNetworkPolicy = ssrfPolicyFromPrivateNetworkOptIn(params.accountConfig);
  return await params.saveRemoteMedia({
    url: params.url,
    maxBytes: params.maxBytes,
    maxRedirects: 0,
    requestInit: {
      headers: { Authorization: params.authorization },
    },
    requireHttps: originProtocol === "https:",
    responseHeaderTimeoutMs: NEXTCLOUD_TALK_MEDIA_RESPONSE_HEADER_TIMEOUT_MS,
    readIdleTimeoutMs: NEXTCLOUD_TALK_MEDIA_READ_IDLE_TIMEOUT_MS,
    filePathHint: params.fileName,
    fallbackContentType: params.mimeType,
    originalFilename: params.fileName,
    ssrfPolicy: {
      ...privateNetworkPolicy,
      hostnameAllowlist: [params.hostname],
    },
  });
}

export function logNextcloudTalkMediaNonOutcome(params: {
  log?: (message: string) => void;
  reason: NextcloudTalkMediaOutcomeReason;
  accountId: string;
  messageId: string;
  senderId: string;
  status?: number;
  sizeBytes?: number;
  maxBytes?: number;
}): void {
  const fields = [
    `reason=${params.reason}`,
    `account=${boundedLogField(params.accountId)}`,
    `message=${boundedLogField(params.messageId)}`,
    `sender=${boundedLogField(normalizeNextcloudTalkAllowEntry(params.senderId))}`,
    ...(params.status === undefined ? [] : [`status=${params.status}`]),
    ...(params.sizeBytes === undefined ? [] : [`sizeBytes=${params.sizeBytes}`]),
    ...(params.maxBytes === undefined ? [] : [`maxBytes=${params.maxBytes}`]),
  ];
  params.log?.(`nextcloud-talk: inbound media non-outcome ${fields.join(" ")}`);
}
