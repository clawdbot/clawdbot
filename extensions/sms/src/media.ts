// Sms plugin module owns inbound Twilio media downloads and outbound MMS hosting.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  formatInboundMediaUnavailableText,
  toInboundMediaFactsWithMetadata,
  type InboundMediaFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import { collectErrorGraphCandidates } from "openclaw/plugin-sdk/error-runtime";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { MediaFetchError, unlinkIfExists } from "openclaw/plugin-sdk/media-runtime";
import { resolveExpiresAtMsFromDurationMs } from "openclaw/plugin-sdk/number-runtime";
import {
  createHostedOutboundMediaStore,
  type HostedOutboundMediaChunkRecord,
  type HostedOutboundMediaMetaRecord,
  type HostedOutboundMediaStore,
  type OutboundMediaLoadOptions,
} from "openclaw/plugin-sdk/outbound-media";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { isTransientNetworkError } from "openclaw/plugin-sdk/retry-runtime";
import { safeEqualSecret, SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
import { getSmsRuntime } from "./runtime.js";
import { TWILIO_MMS_MAX_BYTES } from "./twilio.js";
import type { ResolvedSmsAccount, SmsInboundMessage } from "./types.js";

const TWILIO_API_HOSTNAME = "api.twilio.com";
const TWILIO_MEDIA_PATH_RE =
  /^\/2010-04-01\/Accounts\/([^/]+)\/Messages\/([^/]+)\/Media\/(ME[0-9a-fA-F]{32})$/u;
const TWILIO_MEDIA_TOTAL_TIMEOUT_MS = 60_000;
const TWILIO_MEDIA_RESPONSE_HEADER_TIMEOUT_MS = 30_000;
const TWILIO_MEDIA_READ_IDLE_TIMEOUT_MS = 30_000;
const TWILIO_MEDIA_BATCH_TIMEOUT_MS = 4 * 60_000;
const TWILIO_MEDIA_RETRY = {
  attempts: 2,
  minDelayMs: 500,
  maxDelayMs: 2_000,
  jitter: 0.2,
} as const;
const TWILIO_MMS_IMAGE_MAX_BYTES = 5_000_000;
const TWILIO_MMS_OTHER_MAX_BYTES = 500_000;
const TWILIO_MMS_LARGE_MEDIA_TYPES = new Set(["image/gif", "image/jpeg", "image/jpg", "image/png"]);
const TWILIO_MMS_MEDIA_ONLY_TYPES = new Set(["application/vcard"]);
// Twilio validates the Content-Disposition filename extension for outbound MMS.
const TWILIO_MMS_EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  "application/pdf": ".pdf",
  "application/vcard": ".vcf",
  "audio/3gpp": ".3gp",
  "audio/3gpp2": ".3g2",
  "audio/ac3": ".ac3",
  "audio/amr": ".amr",
  "audio/amr-nb": ".amr",
  "audio/basic": ".au",
  "audio/l24": ".l24",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/vnd.rn-realaudio": ".ra",
  "audio/vnd.wave": ".wav",
  "audio/webm": ".webm",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/tiff": ".tiff",
  "text/calendar": ".ics",
  "text/csv": ".csv",
  "text/directory": ".vcf",
  "text/richtext": ".rtx",
  "text/rtf": ".rtf",
  "text/vcard": ".vcf",
  "text/x-vcard": ".vcf",
  "video/3gpp": ".3gp",
  "video/3gpp-tt": ".3gp",
  "video/3gpp2": ".3g2",
  "video/h261": ".h261",
  "video/h263": ".h263",
  "video/h263-1998": ".h263",
  "video/h263-2000": ".h263",
  "video/h264": ".h264",
  "video/h265": ".h265",
  "video/mp4": ".mp4",
  "video/mpeg": ".mpg",
  "video/mpeg4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
};
const SMS_OUTBOUND_MEDIA_TTL_MS = 10 * 60_000;
const SMS_OUTBOUND_MEDIA_ID_RE = /^[a-f0-9]{24}$/;
const SMS_OUTBOUND_MEDIA_TOKEN_PARAM_PREFIX = "__openclaw_mms_token";
const SMS_OUTBOUND_MEDIA_NAMESPACE = "hosted-outbound-media";
const SMS_OUTBOUND_MEDIA_CHUNKS_NAMESPACE = "hosted-outbound-media-chunks";
const SMS_OUTBOUND_MEDIA_MAX_ENTRIES = 64;
const SMS_OUTBOUND_MEDIA_CHUNK_ROWS_PER_ENTRY_BUDGET = 160;
const SMS_OUTBOUND_MEDIA_MAX_CHUNK_ROWS =
  SMS_OUTBOUND_MEDIA_MAX_ENTRIES * SMS_OUTBOUND_MEDIA_CHUNK_ROWS_PER_ENTRY_BUDGET;

const hostedSmsMediaStores = new Map<string, HostedOutboundMediaStore>();
let hostedSmsMediaRuntime: ReturnType<typeof getSmsRuntime> | undefined;

type PrepareHostedSmsMediaParams = {
  account: ResolvedSmsAccount;
  mediaUrl: string;
  mediaAccess?: OutboundMediaLoadOptions["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  captionByteLength?: number;
};

type PreparedHostedSmsMedia = {
  url: string;
  cleanup: () => Promise<void>;
};

function normalizeBasePath(path: string): string {
  const withLeadingSlash = path.trim().startsWith("/") ? path.trim() : `/${path.trim()}`;
  return withLeadingSlash === "/" ? "" : withLeadingSlash.replace(/\/+$/u, "");
}

function normalizeExactPath(path: string): string {
  return normalizeBasePath(path) || "/";
}

function toHostedStoreRoutePath(path: string): string {
  const normalized = normalizeExactPath(path);
  return normalized === "/" ? normalized : `${normalized}/`;
}

export function resolveSmsHostedMediaRoute(params: {
  webhookPath: string;
  publicWebhookUrl: string;
}): {
  localRoutePath: string;
  publicBaseUrl: string;
  publicRoutePath: string;
  publicSearch: string;
} {
  if (!params.publicWebhookUrl.trim()) {
    throw new Error("MMS send requires channels.sms.publicWebhookUrl.");
  }
  const publicWebhookUrl = new URL(params.publicWebhookUrl);
  if (publicWebhookUrl.protocol !== "https:" || !publicWebhookUrl.hostname) {
    throw new Error("MMS send requires an HTTPS publicWebhookUrl with a hostname.");
  }
  if (publicWebhookUrl.username || publicWebhookUrl.password) {
    throw new Error("MMS send requires a publicWebhookUrl without embedded HTTP authentication.");
  }
  return {
    localRoutePath: toHostedStoreRoutePath(params.webhookPath),
    publicBaseUrl: publicWebhookUrl.origin,
    publicRoutePath: normalizeExactPath(publicWebhookUrl.pathname),
    publicSearch: publicWebhookUrl.search,
  };
}

function createHostedSmsMediaStore(
  runtime: ReturnType<typeof getSmsRuntime>,
  accountId: string,
): HostedOutboundMediaStore {
  const accountScope = createHash("sha256").update(accountId).digest("hex").slice(0, 16);
  return createHostedOutboundMediaStore({
    metadataStore: runtime.state.openKeyedStore<HostedOutboundMediaMetaRecord>({
      namespace: `${SMS_OUTBOUND_MEDIA_NAMESPACE}-${accountScope}`,
      maxEntries: SMS_OUTBOUND_MEDIA_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
    chunkStore: runtime.state.openKeyedStore<HostedOutboundMediaChunkRecord>({
      namespace: `${SMS_OUTBOUND_MEDIA_CHUNKS_NAMESPACE}-${accountScope}`,
      maxEntries: SMS_OUTBOUND_MEDIA_MAX_CHUNK_ROWS,
      overflowPolicy: "reject-new",
    }),
    ttlMs: SMS_OUTBOUND_MEDIA_TTL_MS,
    maxEntries: SMS_OUTBOUND_MEDIA_MAX_ENTRIES,
    maxChunkRows: SMS_OUTBOUND_MEDIA_MAX_CHUNK_ROWS,
    overflowPolicy: "reject-new",
    resolveExpiresAtMs: (ttlMs) => resolveExpiresAtMsFromDurationMs(ttlMs),
  });
}

function getHostedSmsMediaStore(accountId: string): HostedOutboundMediaStore {
  const runtime = getSmsRuntime();
  if (hostedSmsMediaRuntime !== runtime) {
    hostedSmsMediaRuntime = runtime;
    hostedSmsMediaStores.clear();
  }
  const existing = hostedSmsMediaStores.get(accountId);
  if (existing) {
    return existing;
  }
  const created = createHostedSmsMediaStore(runtime, accountId);
  hostedSmsMediaStores.set(accountId, created);
  return created;
}

function createHostedSmsMediaCleanup(
  store: HostedOutboundMediaStore,
  id: string,
): () => Promise<void> {
  let cleanup: Promise<void> | undefined;
  return async () => {
    const activeCleanup = cleanup ?? store.delete(id);
    cleanup = activeCleanup;
    try {
      await activeCleanup;
    } catch (error) {
      if (cleanup === activeCleanup) {
        cleanup = undefined;
      }
      throw error;
    }
  };
}

export async function prepareHostedSmsMedia(
  params: PrepareHostedSmsMediaParams,
): Promise<PreparedHostedSmsMedia> {
  const route = resolveSmsHostedMediaRoute({
    webhookPath: params.account.webhookPath,
    publicWebhookUrl: params.account.publicWebhookUrl,
  });
  const store = getHostedSmsMediaStore(params.account.accountId);
  const captionByteLength = params.captionByteLength ?? 0;
  if (!Number.isSafeInteger(captionByteLength) || captionByteLength < 0) {
    throw new Error("MMS caption byte length must be a non-negative integer.");
  }
  const aggregateMediaBudget = TWILIO_MMS_IMAGE_MAX_BYTES - captionByteLength - 1;
  if (aggregateMediaBudget < 1) {
    throw new Error("Twilio MMS caption leaves no room for an attachment below 5,000,000 bytes.");
  }
  const mediaAccess: OutboundMediaLoadOptions["mediaAccess"] = (() => {
    const localRoots = params.mediaAccess?.localRoots ?? params.mediaLocalRoots;
    const readFile = params.mediaAccess?.readFile ?? params.mediaReadFile;
    const workspaceDir = params.mediaAccess?.workspaceDir;
    if (!localRoots && !readFile && !workspaceDir) {
      return undefined;
    }
    return {
      ...(localRoots ? { localRoots } : {}),
      ...(readFile ? { readFile } : {}),
      ...(workspaceDir ? { workspaceDir } : {}),
    };
  })();
  const stagedUrl = new URL(
    await store.prepareUrl({
      mediaUrl: params.mediaUrl,
      routePath: route.localRoutePath,
      publicBaseUrl: route.publicBaseUrl,
      maxBytes: Math.min(
        params.account.mediaMaxBytes ?? aggregateMediaBudget,
        aggregateMediaBudget,
      ),
      mediaAccess,
    }),
  );
  const id = stagedUrl.pathname.split("/").at(-1) ?? "";
  const token = stagedUrl.searchParams.get("token");
  if (!SMS_OUTBOUND_MEDIA_ID_RE.test(id) || !token) {
    throw new Error("Hosted MMS media URL could not be prepared.");
  }
  const cleanup = createHostedSmsMediaCleanup(store, id);
  const entry = await store.read(id);
  if (!entry) {
    throw new Error("Hosted MMS media expired before it could be sent.");
  }
  const contentType = entry.metadata.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType || !TWILIO_MMS_EXTENSION_BY_TYPE[contentType]) {
    await cleanup();
    throw new Error(
      `Twilio MMS does not support media type ${contentType || "unknown content type"}.`,
    );
  }
  if (captionByteLength > 0 && TWILIO_MMS_MEDIA_ONLY_TYPES.has(contentType)) {
    await cleanup();
    throw new Error(`Twilio MMS media type ${contentType} must be sent without a caption.`);
  }
  const maxBytes = TWILIO_MMS_LARGE_MEDIA_TYPES.has(contentType)
    ? TWILIO_MMS_IMAGE_MAX_BYTES
    : TWILIO_MMS_OTHER_MAX_BYTES;
  if (entry.metadata.byteLength > maxBytes) {
    await cleanup();
    throw new Error(
      `Twilio MMS media exceeds the ${maxBytes.toLocaleString("en-US")} byte limit for ${
        contentType || "unknown content type"
      }.`,
    );
  }
  if (entry.metadata.byteLength + captionByteLength >= TWILIO_MMS_IMAGE_MAX_BYTES) {
    await cleanup();
    throw new Error("Twilio MMS attachment and caption must total less than 5,000,000 bytes.");
  }

  // The random media id namespaces the token parameter so existing proxy query
  // parameters survive without being overwritten or becoming the auth value.
  const tokenParam = `${SMS_OUTBOUND_MEDIA_TOKEN_PARAM_PREFIX}_${id}`;
  const querySeparator = route.publicSearch ? "&" : "?";
  return {
    url: `${route.publicBaseUrl}${route.publicRoutePath}${route.publicSearch}${querySeparator}${tokenParam}=${encodeURIComponent(token)}`,
    cleanup,
  };
}

function requireTwilioMediaUrl(
  rawUrl: string,
  identity: { accountSid: string; messageSid: string },
): string {
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:" ||
    url.hostname !== TWILIO_API_HOSTNAME ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new Error("Twilio MMS media URL must use https://api.twilio.com.");
  }
  const match = TWILIO_MEDIA_PATH_RE.exec(url.pathname);
  if (!match || match[1] !== identity.accountSid || match[2] !== identity.messageSid) {
    throw new Error("Twilio MMS media URL does not match the inbound message.");
  }
  return url.toString();
}

function inboundMediaUnavailableBody(body: string, count: number): string {
  return formatInboundMediaUnavailableText({
    body,
    notice: `[${count} Twilio MMS attachment${count === 1 ? "" : "s"} unavailable]`,
  });
}

function inboundMediaFileName(contentType: string | undefined, index: number): string {
  return `mms-${index + 1}${extensionForMime(contentType) ?? ".bin"}`;
}

function createInboundMediaCleanup(paths: string[]): () => Promise<void> {
  let cleanup: Promise<void> | undefined;
  return async () => {
    cleanup ??= Promise.all(paths.map(async (filePath) => await unlinkIfExists(filePath))).then(
      () => undefined,
    );
    await cleanup;
  };
}

// Keep the SSRF veto on the same wrapper graph as the transient classifier;
// otherwise a transient sibling could make a blocked fetch retry.
function nestedSmsMediaErrorCandidates(candidate: Record<string, unknown>): unknown[] {
  const nested = [
    candidate.cause,
    candidate.reason,
    candidate.original,
    candidate.error,
    candidate.data,
  ];
  if (Array.isArray(candidate.errors)) {
    nested.push(...candidate.errors);
  }
  return nested;
}

function isRetryableSmsInboundMediaError(error: unknown): boolean {
  if (!(error instanceof MediaFetchError)) {
    return false;
  }
  if (error.code === "http_error") {
    return (
      error.status === 408 ||
      error.status === 429 ||
      (typeof error.status === "number" && error.status >= 500)
    );
  }
  if (error.code !== "fetch_failed") {
    return false;
  }
  const candidates = collectErrorGraphCandidates(error.cause, nestedSmsMediaErrorCandidates);
  if (candidates.some((candidate) => candidate instanceof SsrFBlockedError)) {
    return false;
  }
  return isTransientNetworkError(error.cause);
}

export async function materializeSmsInboundMedia(params: {
  account: ResolvedSmsAccount;
  msg: SmsInboundMessage;
  mediaRuntime: Pick<PluginRuntime["channel"], "media">;
  abortSignal?: AbortSignal;
  log?: { warn?: (message: string) => void };
}): Promise<{ body: string; media: InboundMediaFacts[]; cleanup: () => Promise<void> }> {
  const savedPaths: string[] = [];
  const cleanup = createInboundMediaCleanup(savedPaths);
  const declaredUnavailableCount = params.msg.unavailableMediaCount ?? 0;
  if (params.msg.media.length === 0) {
    return {
      body:
        declaredUnavailableCount > 0
          ? inboundMediaUnavailableBody(params.msg.body, declaredUnavailableCount)
          : params.msg.body,
      media: [],
      cleanup,
    };
  }
  const callbackAccountSid = params.msg.accountSid;
  if (!callbackAccountSid || callbackAccountSid !== params.account.accountSid) {
    params.log?.warn?.(
      `Refused Twilio MMS attachments for ${params.msg.messageSid}: webhook account mismatch`,
    );
    return {
      body: inboundMediaUnavailableBody(
        params.msg.body,
        declaredUnavailableCount + params.msg.media.length,
      ),
      media: [],
      cleanup,
    };
  }

  // The operator cap applies per attachment; Twilio's aggregate budget spans the message.
  let remainingBytes = TWILIO_MMS_MAX_BYTES;
  let unavailableCount = declaredUnavailableCount;
  const batchTimeoutSignal = AbortSignal.timeout(TWILIO_MEDIA_BATCH_TIMEOUT_MS);
  const abortSignal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, batchTimeoutSignal])
    : batchTimeoutSignal;
  const savedMedia: Array<{ path: string; contentType?: string; messageId: string }> = [];
  try {
    for (const [index, media] of params.msg.media.entries()) {
      abortSignal.throwIfAborted();
      if (remainingBytes <= 0) {
        unavailableCount += 1;
        continue;
      }
      try {
        const saved = await params.mediaRuntime.media.saveRemoteMedia({
          url: requireTwilioMediaUrl(media.url, {
            accountSid: callbackAccountSid,
            messageSid: params.msg.messageSid,
          }),
          requestInit: {
            headers: {
              authorization: `Basic ${Buffer.from(
                `${params.account.accountSid}:${params.account.authToken}`,
              ).toString("base64")}`,
            },
            signal: abortSignal,
          },
          filePathHint: inboundMediaFileName(media.contentType, index),
          fallbackContentType: media.contentType,
          maxBytes: Math.min(params.account.mediaMaxBytes ?? remainingBytes, remainingBytes),
          ssrfPolicy: { hostnameAllowlist: [TWILIO_API_HOSTNAME] },
          timeoutMs: TWILIO_MEDIA_TOTAL_TIMEOUT_MS,
          responseHeaderTimeoutMs: TWILIO_MEDIA_RESPONSE_HEADER_TIMEOUT_MS,
          readIdleTimeoutMs: TWILIO_MEDIA_READ_IDLE_TIMEOUT_MS,
          retry: TWILIO_MEDIA_RETRY,
        });
        remainingBytes -= saved.size;
        savedPaths.push(saved.path);
        savedMedia.push({
          path: saved.path,
          contentType: saved.contentType ?? media.contentType,
          messageId: params.msg.messageSid,
        });
      } catch (error) {
        abortSignal.throwIfAborted();
        // Adoption tombstones the callback, so only a pre-adoption throw lets
        // the durable sender lane retry a transient Twilio media failure.
        if (isRetryableSmsInboundMediaError(error)) {
          throw error;
        }
        unavailableCount += 1;
        params.log?.warn?.(
          `Failed to download Twilio MMS attachment ${index + 1} for ${params.msg.messageSid}`,
        );
      }
    }

    const body =
      unavailableCount > 0
        ? inboundMediaUnavailableBody(params.msg.body, unavailableCount)
        : params.msg.body;
    return {
      body,
      media: await toInboundMediaFactsWithMetadata(savedMedia),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function hostedSmsMediaFileName(id: string, contentType: string | undefined): string | undefined {
  const normalizedContentType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  const extension = normalizedContentType
    ? TWILIO_MMS_EXTENSION_BY_TYPE[normalizedContentType]
    : undefined;
  return extension ? `mms-${id.slice(0, 10)}${extension}` : undefined;
}

export async function tryHandleHostedSmsMediaRequest(
  req: IncomingMessage,
  res: ServerResponse,
  accountId = "default",
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    return false;
  }
  const tokenCandidates = [...url.searchParams.entries()]
    .filter(([key]) => key.startsWith(`${SMS_OUTBOUND_MEDIA_TOKEN_PARAM_PREFIX}_`))
    .map(([key, token]) => ({
      id: key.slice(SMS_OUTBOUND_MEDIA_TOKEN_PARAM_PREFIX.length + 1),
      token,
    }))
    .filter((candidate) => SMS_OUTBOUND_MEDIA_ID_RE.test(candidate.id));
  if (tokenCandidates.length === 0) {
    return false;
  }
  if (tokenCandidates.length !== 1) {
    res.statusCode = 400;
    res.end("Bad Request");
    return true;
  }
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end("Method Not Allowed");
    return true;
  }
  const routePath = toHostedStoreRoutePath(url.pathname);
  const store = getHostedSmsMediaStore(accountId);
  const candidate = tokenCandidates[0];
  if (!candidate) {
    return false;
  }
  const metadata = await store.readMetadata(candidate.id);
  if (!metadata || metadata.routePath !== routePath) {
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }
  if (!safeEqualSecret(candidate.token, metadata.token)) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return true;
  }

  let servedMetadata = metadata;
  let body: Buffer | undefined;
  if (method === "GET") {
    const entry = await store.read(candidate.id);
    if (
      !entry ||
      entry.metadata.routePath !== routePath ||
      !safeEqualSecret(candidate.token, entry.metadata.token)
    ) {
      res.statusCode = 404;
      res.end("Not Found");
      return true;
    }
    servedMetadata = entry.metadata;
    body = entry.buffer;
  }

  const contentType = servedMetadata.contentType ?? "application/octet-stream";
  const fileName = hostedSmsMediaFileName(candidate.id, contentType);
  if (!fileName) {
    res.statusCode = 415;
    res.end("Unsupported Media Type");
    return true;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", String(servedMetadata.byteLength));
  res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(body);
  return true;
}
