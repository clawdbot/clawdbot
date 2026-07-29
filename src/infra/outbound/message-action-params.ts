// Message-action param normalization hydrates media sources, sandbox paths,
// base64 buffers, JSON params, and plugin-owned media aliases.
import { canonicalizeBase64, estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { basenameFromAnyPath } from "@openclaw/media-core/file-name";
import { extensionForMime } from "@openclaw/media-core/mime";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { assertMediaNotDataUrl, resolveSandboxedMediaSource } from "../../agents/sandbox-paths.js";
import { readStringArrayParam, readStringParam } from "../../agents/tools/common.js";
import { resolveChannelMessageToolMediaSourceParamKeys } from "../../channels/plugins/message-action-discovery.js";
import type { ChannelId, ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { root } from "../../infra/fs-safe.js";
import { basenameFromMediaSource } from "../../infra/local-file-access.js";
import { resolveChannelAccountMediaMaxMb } from "../../media/configured-max-bytes.js";
import {
  buildOutboundMediaLoadOptions,
  resolveOutboundMediaAccess,
  resolveOutboundMediaLocalRoots,
  type OutboundMediaAccess,
  type OutboundMediaReadFile,
} from "../../media/load-options.js";
import { resolveOutboundAttachmentFromBuffer } from "../../media/outbound-attachment.js";
import { MEDIA_MAX_BYTES } from "../../media/store.js";
import { loadWebMedia } from "../../media/web-media.js";
import { resolveSnakeCaseParamKey } from "../../param-key.js";
import { readBooleanParam as readBooleanParamShared } from "../../plugin-sdk/boolean-param.js";
import { hasPotentialPluginActionParam } from "./message-action-param-keys.js";

/** Shared boolean param reader used by message-action argument normalization. */
export const readBooleanParam = readBooleanParamShared;

const BASE_ACTION_MEDIA_SOURCE_PARAM_KEYS = [
  "media",
  "path",
  "filePath",
  "mediaUrl",
  "fileUrl",
  "image",
] as const;

const STRUCTURED_ATTACHMENT_MEDIA_SOURCE_PARAM_KEYS = [
  "media",
  "mediaUrl",
  "path",
  "filePath",
  "fileUrl",
  "url",
] as const;
const STRUCTURED_ATTACHMENT_FILE_SOURCE_PARAM_KEYS = new Set(["path", "filePath", "fileUrl"]);
const SEND_BUFFER_DRY_RUN_MEDIA_URL = "buffer://message-send/attachment";

type StructuredAttachmentSource = {
  attachment: Record<string, unknown>;
  key: string;
  value: string;
  kind: "media" | "file";
  contentType?: string;
  filename?: string;
};

type StructuredAttachmentMode = "selected" | "all";

function readMediaParam(args: Record<string, unknown>, key: string): string | undefined {
  return readStringParam(args, key, { trim: false });
}

function resolveMediaParamEntry(
  args: Record<string, unknown>,
  key: string,
): { key: string; value: string } | undefined {
  const resolvedKey = resolveSnakeCaseParamKey(args, key);
  if (!resolvedKey) {
    return undefined;
  }
  const value = readMediaParam(args, key);
  if (!value) {
    return undefined;
  }
  return {
    key: resolvedKey,
    value,
  };
}

function hasExplicitAttachmentPayload(
  args: Record<string, unknown>,
  extraParamKeys?: readonly string[],
): boolean {
  if (readStringParam(args, "buffer", { trim: false })) {
    return true;
  }
  return buildActionMediaSourceParamKeys(extraParamKeys).some((key) => {
    const entry = resolveMediaParamEntry(args, key);
    return Boolean(entry && normalizeOptionalString(entry.value));
  });
}

function hasExplicitSendMediaSource(
  args: Record<string, unknown>,
  extraParamKeys?: readonly string[],
): boolean {
  if (
    buildActionMediaSourceParamKeys(extraParamKeys).some((key) => {
      const entry = resolveMediaParamEntry(args, key);
      const value = entry ? normalizeOptionalString(entry.value) : undefined;
      return Boolean(value && value !== SEND_BUFFER_DRY_RUN_MEDIA_URL);
    })
  ) {
    return true;
  }
  const mediaUrls = readStringArrayParam(args, "mediaUrls");
  if (
    mediaUrls?.some((value) => {
      const normalized = normalizeOptionalString(value);
      return Boolean(normalized && normalized !== SEND_BUFFER_DRY_RUN_MEDIA_URL);
    })
  ) {
    return true;
  }
  return collectStructuredAttachmentSources(args).some((source) =>
    Boolean(normalizeOptionalString(source.value)),
  );
}

function collectStructuredAttachmentSources(
  args: Record<string, unknown>,
): StructuredAttachmentSource[] {
  const attachments = args.attachments;
  if (!Array.isArray(attachments)) {
    return [];
  }
  const sources: StructuredAttachmentSource[] = [];
  for (const attachment of attachments) {
    if (!isRecord(attachment)) {
      continue;
    }
    for (const key of STRUCTURED_ATTACHMENT_MEDIA_SOURCE_PARAM_KEYS) {
      const entry = resolveMediaParamEntry(attachment, key);
      if (!entry || !normalizeOptionalString(entry.value)) {
        continue;
      }
      sources.push({
        attachment,
        key: entry.key,
        value: entry.value,
        kind: STRUCTURED_ATTACHMENT_FILE_SOURCE_PARAM_KEYS.has(key) ? "file" : "media",
        contentType:
          readStringParam(attachment, "contentType") ?? readStringParam(attachment, "mimeType"),
        filename: readStringParam(attachment, "filename") ?? readStringParam(attachment, "name"),
      });
      break;
    }
  }
  return sources;
}

function resolveStructuredAttachmentSource(
  args: Record<string, unknown>,
  extraParamKeys?: readonly string[],
): StructuredAttachmentSource | undefined {
  if (hasExplicitAttachmentPayload(args, extraParamKeys)) {
    return undefined;
  }
  return collectStructuredAttachmentSources(args)[0];
}

function buildActionMediaSourceParamKeys(extraParamKeys?: readonly string[]): string[] {
  const keys = new Set<string>(BASE_ACTION_MEDIA_SOURCE_PARAM_KEYS);
  extraParamKeys?.forEach((key) => keys.add(key));
  return Array.from(keys);
}

/** Resolves plugin-declared media source param aliases for a message action. */
export function resolveExtraActionMediaSourceParamKeys(params: {
  cfg: OpenClawConfig;
  action?: ChannelMessageActionName;
  args: Record<string, unknown>;
  channel?: string;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
}): string[] {
  if (!hasPotentialPluginActionParam(params.args)) {
    // Standard send params never need bundled action metadata discovery.
    return [];
  }
  return resolveChannelMessageToolMediaSourceParamKeys({
    cfg: params.cfg,
    action: params.action,
    channel: params.channel,
    accountId: params.accountId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    requesterSenderId: params.requesterSenderId,
    senderIsOwner: params.senderIsOwner,
  });
}

/** Collects candidate media source strings from message-action args. */
export function collectActionMediaSourceHints(
  args: Record<string, unknown>,
  extraParamKeys?: readonly string[],
  options?: { structuredAttachments?: StructuredAttachmentMode },
): string[] {
  const sources: string[] = [];
  for (const key of buildActionMediaSourceParamKeys(extraParamKeys)) {
    const entry = resolveMediaParamEntry(args, key);
    if (entry && normalizeOptionalString(entry.value)) {
      sources.push(entry.value);
    }
  }
  for (const value of readStringArrayParam(args, "mediaUrls") ?? []) {
    if (normalizeOptionalString(value)) {
      sources.push(value);
    }
  }
  if (options?.structuredAttachments === "all") {
    sources.push(...collectStructuredAttachmentSources(args).map((source) => source.value));
  } else {
    const attachmentSource = resolveStructuredAttachmentSource(args, extraParamKeys);
    if (attachmentSource) {
      sources.push(attachmentSource.value);
    }
  }
  return sources;
}

function readAttachmentMediaHint(args: Record<string, unknown>): string | undefined {
  return readMediaParam(args, "media") ?? readMediaParam(args, "mediaUrl");
}

function readAttachmentFileHint(args: Record<string, unknown>): string | undefined {
  return (
    readMediaParam(args, "path") ??
    readMediaParam(args, "filePath") ??
    readMediaParam(args, "fileUrl")
  );
}

function resolveAttachmentMaxBytes(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
}): number | undefined {
  // Priority: account-specific > channel-level > global default
  const limitMb =
    resolveChannelAccountMediaMaxMb(params) ?? params.cfg.agents?.defaults?.mediaMaxMb;
  return typeof limitMb === "number" ? limitMb * 1024 * 1024 : undefined;
}

function inferAttachmentFilename(params: {
  mediaHint?: string;
  contentType?: string;
}): string | undefined {
  const mediaHint = params.mediaHint?.trim();
  if (mediaHint) {
    const base = basenameFromMediaSource(mediaHint);
    const safeBase = base ? basenameFromAnyPath(base) : undefined;
    if (safeBase) {
      return safeBase;
    }
  }
  const ext = params.contentType ? extensionForMime(params.contentType) : undefined;
  return ext ? `attachment${ext}` : "attachment";
}

function normalizeBase64Payload(params: { base64?: string; contentType?: string }): {
  base64?: string;
  contentType?: string;
} {
  if (!params.base64) {
    return { base64: params.base64, contentType: params.contentType };
  }
  const match = /^data:([^;]+);base64,(.*)$/i.exec(params.base64.trim());
  if (!match) {
    return { base64: params.base64, contentType: params.contentType };
  }
  const [, mime, payload] = match;
  return {
    base64: payload,
    contentType: params.contentType ?? mime,
  };
}

function resolveSendBufferMaxBytes(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
}): number {
  return (
    resolveAttachmentMaxBytes({
      cfg: params.cfg,
      channel: params.channel,
      accountId: params.accountId,
    }) ?? MEDIA_MAX_BYTES
  );
}

function decodeBoundedBase64Attachment(params: { base64: string; maxBytes: number }): Buffer {
  const estimatedBytes = estimateBase64DecodedBytes(params.base64);
  if (estimatedBytes > params.maxBytes) {
    throw new Error(`Media too large: ${estimatedBytes} bytes (limit: ${params.maxBytes} bytes)`);
  }
  const canonicalBase64 = canonicalizeBase64(params.base64);
  if (!canonicalBase64) {
    throw new Error("message.send buffer has invalid base64 data");
  }
  const buffer = Buffer.from(canonicalBase64, "base64");
  if (buffer.byteLength > params.maxBytes) {
    throw new Error(
      `Media too large: ${buffer.byteLength} bytes (limit: ${params.maxBytes} bytes)`,
    );
  }
  return buffer;
}

async function hydrateSendBufferMediaParams(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  args: Record<string, unknown>;
  dryRun?: boolean;
  preserveBuffer?: boolean;
  extraParamKeys?: readonly string[];
}): Promise<void> {
  if (hasExplicitSendMediaSource(params.args, params.extraParamKeys)) {
    delete params.args.buffer;
    return;
  }
  const rawBuffer = readStringParam(params.args, "buffer", { trim: false });
  if (!rawBuffer) {
    return;
  }
  const normalized = normalizeBase64Payload({
    base64: rawBuffer,
    contentType: readStringParam(params.args, "contentType") ?? undefined,
  });
  if (!normalized.base64) {
    return;
  }
  const contentType =
    readStringParam(params.args, "contentType") ??
    readStringParam(params.args, "mimeType") ??
    normalized.contentType;
  const filename =
    readStringParam(params.args, "filename") ??
    inferAttachmentFilename({
      contentType: contentType ?? undefined,
    });
  const maxBytes = resolveSendBufferMaxBytes(params);
  if (params.dryRun || params.preserveBuffer) {
    decodeBoundedBase64Attachment({
      base64: normalized.base64,
      maxBytes,
    });
    params.args.media = SEND_BUFFER_DRY_RUN_MEDIA_URL;
    params.args.mediaUrl = SEND_BUFFER_DRY_RUN_MEDIA_URL;
    params.args.mediaUrls = [SEND_BUFFER_DRY_RUN_MEDIA_URL];
    if (!params.preserveBuffer) {
      delete params.args.buffer;
    }
    if (normalized.contentType && !readStringParam(params.args, "contentType")) {
      params.args.contentType = normalized.contentType;
    }
    if (filename && !readStringParam(params.args, "filename")) {
      params.args.filename = filename;
    }
    return;
  }
  const staged = await resolveOutboundAttachmentFromBuffer(
    decodeBoundedBase64Attachment({
      base64: normalized.base64,
      maxBytes,
    }),
    maxBytes,
    {
      contentType: contentType ?? undefined,
      filename,
    },
  );
  params.args.media = staged.path;
  params.args.mediaUrl = staged.path;
  params.args.mediaUrls = [staged.path];
  delete params.args.buffer;
  if (staged.contentType && !readStringParam(params.args, "contentType")) {
    params.args.contentType = staged.contentType;
  }
  if (filename && !readStringParam(params.args, "filename")) {
    params.args.filename = filename;
  }
}

/** Media access policy used when hydrating attachment action parameters. */
type AttachmentMediaPolicy =
  | {
      mode: "sandbox";
      sandboxRoot: string;
    }
  | {
      mode: "host";
      mediaAccess?: OutboundMediaAccess;
      mediaLocalRoots?: readonly string[] | "any";
      mediaReadFile?: OutboundMediaReadFile;
    };

/** Chooses sandbox or host media loading policy for attachment hydration. */
export function resolveAttachmentMediaPolicy(params: {
  sandboxRoot?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[] | "any";
  mediaReadFile?: OutboundMediaReadFile;
}): AttachmentMediaPolicy {
  const sandboxRoot = params.sandboxRoot?.trim();
  if (sandboxRoot) {
    return {
      mode: "sandbox",
      sandboxRoot,
    };
  }
  const explicitLocalRoots = resolveOutboundMediaLocalRoots(params.mediaLocalRoots);
  return {
    mode: "host",
    mediaAccess: resolveOutboundMediaAccess({
      mediaAccess: params.mediaAccess,
      mediaLocalRoots: explicitLocalRoots === "any" ? undefined : explicitLocalRoots,
      mediaReadFile: params.mediaAccess?.readFile ? undefined : params.mediaReadFile,
    }),
    ...(explicitLocalRoots !== undefined ? { mediaLocalRoots: explicitLocalRoots } : {}),
    ...(params.mediaAccess?.readFile
      ? {}
      : params.mediaReadFile
        ? { mediaReadFile: params.mediaReadFile }
        : {}),
  };
}

function buildAttachmentMediaLoadOptions(params: {
  policy: AttachmentMediaPolicy;
  maxBytes?: number;
  optimizeImages?: boolean;
}):
  | {
      maxBytes?: number;
      optimizeImages?: boolean;
      sandboxValidated: true;
      readFile: (filePath: string) => Promise<Buffer>;
    }
  | {
      maxBytes?: number;
      localRoots?: readonly string[] | "any";
      readFile?: OutboundMediaReadFile;
      hostReadCapability?: boolean;
      optimizeImages?: boolean;
    } {
  if (params.policy.mode === "sandbox") {
    const sandboxRoot = params.policy.sandboxRoot.trim();
    let sandboxFsPromise: ReturnType<typeof root> | undefined;
    const readSandboxFile = async (filePath: string): Promise<Buffer> => {
      sandboxFsPromise ??= root(sandboxRoot);
      return await (await sandboxFsPromise).readBytes(filePath);
    };
    return {
      maxBytes: params.maxBytes,
      ...(params.optimizeImages !== undefined ? { optimizeImages: params.optimizeImages } : {}),
      sandboxValidated: true,
      readFile: readSandboxFile,
    };
  }
  return buildOutboundMediaLoadOptions({
    maxBytes: params.maxBytes,
    mediaAccess: params.policy.mediaAccess,
    mediaLocalRoots: params.policy.mediaLocalRoots,
    mediaReadFile: params.policy.mediaReadFile,
    optimizeImages: params.optimizeImages,
  });
}

async function hydrateAttachmentPayload(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  args: Record<string, unknown>;
  dryRun?: boolean;
  contentTypeParam?: string | null;
  mediaHint?: string | null;
  fileHint?: string | null;
  mediaPolicy: AttachmentMediaPolicy;
  optimizeImages?: boolean;
}) {
  const contentTypeParam = params.contentTypeParam ?? undefined;
  const rawBuffer = readStringParam(params.args, "buffer", { trim: false });
  const normalized = normalizeBase64Payload({
    base64: rawBuffer,
    contentType: contentTypeParam ?? undefined,
  });
  if (normalized.base64 !== rawBuffer && normalized.base64) {
    params.args.buffer = normalized.base64;
    if (normalized.contentType && !contentTypeParam) {
      params.args.contentType = normalized.contentType;
    }
  }

  const filename = readStringParam(params.args, "filename");
  const mediaSource = (params.mediaHint ?? undefined) || (params.fileHint ?? undefined);

  if (!params.dryRun && !readStringParam(params.args, "buffer", { trim: false }) && mediaSource) {
    const maxBytes = resolveAttachmentMaxBytes({
      cfg: params.cfg,
      channel: params.channel,
      accountId: params.accountId,
    });
    const media = await loadWebMedia(
      mediaSource,
      buildAttachmentMediaLoadOptions({
        policy: params.mediaPolicy,
        maxBytes,
        optimizeImages: params.optimizeImages,
      }),
    );
    params.args.buffer = media.buffer.toString("base64");
    if (!contentTypeParam && media.contentType) {
      params.args.contentType = media.contentType;
    }
    if (!filename) {
      params.args.filename = inferAttachmentFilename({
        mediaHint: media.fileName ?? mediaSource,
        contentType: media.contentType ?? contentTypeParam ?? undefined,
      });
    }
  } else if (!filename) {
    params.args.filename = inferAttachmentFilename({
      mediaHint: mediaSource,
      contentType: contentTypeParam ?? undefined,
    });
  }
}

/** Rewrites action media params to sandbox-safe paths and rejects data URLs. */
export async function normalizeSandboxMediaParams(params: {
  args: Record<string, unknown>;
  mediaPolicy: AttachmentMediaPolicy;
  extraParamKeys?: readonly string[];
  structuredAttachments?: StructuredAttachmentMode;
}): Promise<void> {
  const sandboxRoot =
    params.mediaPolicy.mode === "sandbox" ? params.mediaPolicy.sandboxRoot.trim() : undefined;
  for (const key of buildActionMediaSourceParamKeys(params.extraParamKeys)) {
    const entry = resolveMediaParamEntry(params.args, key);
    if (!entry) {
      continue;
    }
    assertMediaNotDataUrl(entry.value);
    if (!sandboxRoot) {
      continue;
    }
    const normalized = await resolveSandboxedMediaSource({ media: entry.value, sandboxRoot });
    if (normalized !== entry.value) {
      params.args[entry.key] = normalized;
    }
  }
  const attachmentSources =
    params.structuredAttachments === "all"
      ? collectStructuredAttachmentSources(params.args)
      : [resolveStructuredAttachmentSource(params.args, params.extraParamKeys)].filter(
          (source): source is StructuredAttachmentSource => Boolean(source),
        );
  if (attachmentSources.length === 0) {
    return;
  }
  for (const attachmentSource of attachmentSources) {
    assertMediaNotDataUrl(attachmentSource.value);
    if (!sandboxRoot) {
      continue;
    }
    const normalized = await resolveSandboxedMediaSource({
      media: attachmentSource.value,
      sandboxRoot,
    });
    if (normalized !== attachmentSource.value) {
      attachmentSource.attachment[attachmentSource.key] = normalized;
    }
  }
}

/** Normalizes a list of media hints against an optional sandbox root. */
export async function normalizeSandboxMediaList(params: {
  values: string[];
  sandboxRoot?: string;
}): Promise<string[]> {
  const sandboxRoot = params.sandboxRoot?.trim();
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of params.values) {
    const raw = value?.trim();
    if (!raw) {
      continue;
    }
    assertMediaNotDataUrl(raw);
    const resolved = sandboxRoot
      ? await resolveSandboxedMediaSource({ media: raw, sandboxRoot })
      : raw;
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    normalized.push(resolved);
  }
  return normalized;
}

async function hydrateAttachmentActionPayload(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  args: Record<string, unknown>;
  dryRun?: boolean;
  /** If caption is missing, copy message -> caption. */
  allowMessageCaptionFallback?: boolean;
  mediaPolicy: AttachmentMediaPolicy;
  optimizeImages?: boolean;
  extraParamKeys?: readonly string[];
}): Promise<void> {
  const attachmentSource = resolveStructuredAttachmentSource(params.args, params.extraParamKeys);
  const mediaHint = readAttachmentMediaHint(params.args);
  const fileHint = readAttachmentFileHint(params.args);
  const contentTypeParam =
    readStringParam(params.args, "contentType") ??
    readStringParam(params.args, "mimeType") ??
    attachmentSource?.contentType;
  if (attachmentSource?.filename && !readStringParam(params.args, "filename")) {
    params.args.filename = attachmentSource.filename;
  }
  if (attachmentSource?.contentType && !readStringParam(params.args, "contentType")) {
    params.args.contentType = attachmentSource.contentType;
  }

  if (params.allowMessageCaptionFallback) {
    const caption = readStringParam(params.args, "caption", { allowEmpty: true })?.trim();
    const message = readStringParam(params.args, "message", { allowEmpty: true })?.trim();
    if (!caption && message) {
      params.args.caption = message;
    }
  }

  await hydrateAttachmentPayload({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    args: params.args,
    dryRun: params.dryRun,
    contentTypeParam,
    mediaHint:
      mediaHint ?? (attachmentSource?.kind === "media" ? attachmentSource.value : undefined),
    fileHint: fileHint ?? (attachmentSource?.kind === "file" ? attachmentSource.value : undefined),
    mediaPolicy: params.mediaPolicy,
    optimizeImages: params.optimizeImages,
  });
}

/** Hydrates attachment-bearing message actions with base64 buffers and metadata. */
export async function hydrateAttachmentParamsForAction(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  args: Record<string, unknown>;
  action: ChannelMessageActionName;
  dryRun?: boolean;
  preserveSendBuffer?: boolean;
  mediaPolicy: AttachmentMediaPolicy;
  extraParamKeys?: readonly string[];
}): Promise<void> {
  const shouldHydrateUploadFile = params.action === "upload-file";
  if (params.action === "send") {
    await hydrateSendBufferMediaParams({
      cfg: params.cfg,
      channel: params.channel,
      accountId: params.accountId,
      args: params.args,
      dryRun: params.dryRun,
      preserveBuffer: params.preserveSendBuffer,
      extraParamKeys: params.extraParamKeys,
    });
    return;
  }
  // Reply gets the same hydration as sendAttachment so threaded sends with
  // an attachment go through the resolver's localRoots/sandbox/size checks
  // instead of forwarding raw paths to the channel runtime. Reply has its
  // own `text`/`message` field, so don't fall back caption -> message.
  if (
    params.action !== "sendAttachment" &&
    params.action !== "setGroupIcon" &&
    params.action !== "reply" &&
    !shouldHydrateUploadFile
  ) {
    return;
  }
  const forceDocument =
    readBooleanParamShared(params.args, "forceDocument") ??
    readBooleanParamShared(params.args, "asDocument") ??
    false;
  await hydrateAttachmentActionPayload({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    args: params.args,
    dryRun: params.dryRun,
    mediaPolicy: params.mediaPolicy,
    extraParamKeys: params.extraParamKeys,
    optimizeImages: shouldHydrateUploadFile && forceDocument ? false : undefined,
    allowMessageCaptionFallback: params.action === "sendAttachment" || shouldHydrateUploadFile,
  });
}

/** Parses a named string param as JSON for structured message action fields. */
export function parseJsonMessageParam(params: Record<string, unknown>, key: string): void {
  const raw = params[key];
  if (typeof raw !== "string") {
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    delete params[key];
    return;
  }
  try {
    params[key] = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(`--${key} must be valid JSON`);
  }
}

/** Parses the interactive message action param as JSON when provided as a string. */
export function parseInteractiveParam(params: Record<string, unknown>): void {
  const raw = params.interactive;
  if (typeof raw !== "string") {
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    delete params.interactive;
    return;
  }
  try {
    params.interactive = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("--interactive must be valid JSON");
  }
}
