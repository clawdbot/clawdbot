import { assertMediaNotDataUrl, resolveSandboxedMediaSource } from "../../agents/sandbox-paths.js";
import { readStringParam } from "../../agents/tools/common.js";
import { resolveChannelMessageToolMediaSourceParamKeys } from "../../channels/plugins/message-action-discovery.js";
import type { ChannelId, ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createRootScopedReadFile } from "../../infra/fs-safe.js";
import { basenameFromMediaSource } from "../../infra/local-file-access.js";
import {
  buildOutboundMediaLoadOptions,
  resolveOutboundMediaAccess,
  resolveOutboundMediaLocalRoots,
  type OutboundMediaAccess,
  type OutboundMediaReadFile,
} from "../../media/load-options.js";
import { extensionForMime } from "../../media/mime.js";
import { loadWebMedia } from "../../media/web-media.js";
import { resolveSnakeCaseParamKey } from "../../param-key.js";
import { readBooleanParam as readBooleanParamShared } from "../../plugin-sdk/boolean-param.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

export const readBooleanParam = readBooleanParamShared;

export const BASE_ACTION_MEDIA_SOURCE_PARAM_KEYS = [
  "media",
  "path",
  "filePath",
  "mediaUrl",
  "fileUrl",
  "image",
] as const;

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

function buildActionMediaSourceParamKeys(extraParamKeys?: readonly string[]): string[] {
  const keys = new Set<string>(BASE_ACTION_MEDIA_SOURCE_PARAM_KEYS);
  extraParamKeys?.forEach((key) => keys.add(key));
  return Array.from(keys);
}

export function resolveExtraActionMediaSourceParamKeys(params: {
  cfg: OpenClawConfig;
  action?: ChannelMessageActionName;
  channel?: string;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
}): string[] {
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

export function collectActionMediaSourceHints(
  args: Record<string, unknown>,
  extraParamKeys?: readonly string[],
): string[] {
  const sources: string[] = [];
  for (const key of buildActionMediaSourceParamKeys(extraParamKeys)) {
    const entry = resolveMediaParamEntry(args, key);
    if (entry && normalizeOptionalString(entry.value)) {
      sources.push(entry.value);
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
  const accountId = typeof params.accountId === "string" ? params.accountId.trim() : "";
  const channelCfg = params.cfg.channels?.[params.channel];
  const channelObj =
    channelCfg && typeof channelCfg === "object"
      ? (channelCfg as Record<string, unknown>)
      : undefined;
  const channelMediaMax =
    typeof channelObj?.mediaMaxMb === "number" ? channelObj.mediaMaxMb : undefined;
  const accountsObj =
    channelObj?.accounts && typeof channelObj.accounts === "object"
      ? (channelObj.accounts as Record<string, unknown>)
      : undefined;
  const accountCfg = accountId && accountsObj ? accountsObj[accountId] : undefined;
  const accountMediaMax =
    accountCfg && typeof accountCfg === "object"
      ? (accountCfg as Record<string, unknown>).mediaMaxMb
      : undefined;
  // Priority: account-specific > channel-level > global default
  const limitMb =
    (typeof accountMediaMax === "number" ? accountMediaMax : undefined) ??
    channelMediaMax ??
    params.cfg.agents?.defaults?.mediaMaxMb;
  return typeof limitMb === "number" ? limitMb * 1024 * 1024 : undefined;
}

function inferAttachmentFilename(params: {
  mediaHint?: string;
  contentType?: string;
}): string | undefined {
  const mediaHint = params.mediaHint?.trim();
  if (mediaHint) {
    const base = basenameFromMediaSource(mediaHint);
    if (base) {
      return base;
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

export type AttachmentMediaPolicy =
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
}):
  | {
      maxBytes?: number;
      sandboxValidated: true;
      readFile: (filePath: string) => Promise<Buffer>;
    }
  | {
      maxBytes?: number;
      localRoots?: readonly string[] | "any";
      readFile?: OutboundMediaReadFile;
      hostReadCapability?: boolean;
    } {
  if (params.policy.mode === "sandbox") {
    const readSandboxFile = createRootScopedReadFile({
      rootDir: params.policy.sandboxRoot.trim(),
    });
    return {
      maxBytes: params.maxBytes,
      sandboxValidated: true,
      readFile: readSandboxFile,
    };
  }
  return buildOutboundMediaLoadOptions({
    maxBytes: params.maxBytes,
    mediaAccess: params.policy.mediaAccess,
    mediaLocalRoots: params.policy.mediaLocalRoots,
    mediaReadFile: params.policy.mediaReadFile,
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
      buildAttachmentMediaLoadOptions({ policy: params.mediaPolicy, maxBytes }),
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

export async function normalizeSandboxMediaParams(params: {
  args: Record<string, unknown>;
  mediaPolicy: AttachmentMediaPolicy;
  extraParamKeys?: readonly string[];
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
}

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
}): Promise<void> {
  const mediaHint = readAttachmentMediaHint(params.args);
  const fileHint = readAttachmentFileHint(params.args);
  const contentTypeParam =
    readStringParam(params.args, "contentType") ?? readStringParam(params.args, "mimeType");

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
    mediaHint,
    fileHint,
    mediaPolicy: params.mediaPolicy,
  });
}

export async function hydrateAttachmentParamsForAction(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  args: Record<string, unknown>;
  action: ChannelMessageActionName;
  dryRun?: boolean;
  mediaPolicy: AttachmentMediaPolicy;
}): Promise<void> {
  const shouldHydrateUploadFile = params.action === "upload-file";
  if (
    params.action !== "sendAttachment" &&
    params.action !== "setGroupIcon" &&
    !shouldHydrateUploadFile
  ) {
    return;
  }
  await hydrateAttachmentActionPayload({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    args: params.args,
    dryRun: params.dryRun,
    mediaPolicy: params.mediaPolicy,
    allowMessageCaptionFallback: params.action === "sendAttachment" || shouldHydrateUploadFile,
  });
}

export function parseButtonsParam(params: Record<string, unknown>): void {
  const raw = params.buttons;
  if (typeof raw !== "string") {
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    delete params.buttons;
    return;
  }
  try {
    params.buttons = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("--buttons must be valid JSON");
  }
}

export function parseCardParam(params: Record<string, unknown>): void {
  const raw = params.card;
  if (typeof raw !== "string") {
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    delete params.card;
    return;
  }
  try {
    params.card = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("--card must be valid JSON");
  }
}

export function parseComponentsParam(params: Record<string, unknown>): void {
  const raw = params.components;
  if (typeof raw !== "string") {
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    delete params.components;
    return;
  }
  try {
    params.components = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("--components must be valid JSON");
  }
}

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
