import * as fsPromises from "node:fs/promises";
import { lstat } from "node:fs/promises";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolvePathFromInput } from "../agents/path-policy.js";
import { resolveWorkspaceRoot } from "../agents/workspace-dir.js";
import { extractDeliveryInfo } from "../config/sessions/delivery-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { detectMime, FILE_TYPE_SNIFF_MAX_BYTES, normalizeMimeType } from "../media/mime.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import type {
  PluginAttachmentChannelHints,
  PluginSessionAttachmentCaptionFormat,
  PluginSessionAttachmentParams,
  PluginSessionAttachmentResult,
} from "./host-hooks.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const attachmentProbeFs = {
  open: (...args: Parameters<typeof fsPromises.open>) => fsPromises.open(...args),
};
const MAX_ATTACHMENT_FILES = 10;

type SendMessage = typeof import("../infra/outbound/message.js").sendMessage;
let sendMessagePromise: Promise<SendMessage> | undefined;

async function loadSendMessage(): Promise<SendMessage> {
  sendMessagePromise ??= import("../infra/outbound/message.js").then(
    (module) => module.sendMessage,
  );
  return sendMessagePromise;
}

type GetChannelPlugin = typeof import("../channels/plugins/index.js").getChannelPlugin;
let getChannelPluginPromise: Promise<GetChannelPlugin> | undefined;

type AttachmentDeliveryChannelPlugin = {
  outbound?: {
    deliveryMode?: string;
  };
};

async function loadGetChannelPlugin(): Promise<GetChannelPlugin> {
  getChannelPluginPromise ??= import("../channels/plugins/index.js").then(
    (module) => module.getChannelPlugin,
  );
  return getChannelPluginPromise;
}

type ResolvedAttachmentDelivery = {
  parseMode?: "HTML";
  escapePlainHtmlCaption?: boolean;
  disableNotification?: boolean;
  forceDocumentMime?: string;
  threadTs?: string;
};

function captionFormatToParseMode(
  captionFormat: PluginSessionAttachmentCaptionFormat | undefined,
): "HTML" | undefined {
  if (captionFormat === "html") {
    return "HTML";
  }
  return undefined;
}

function escapeHtmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function readMimeSniffBuffer(
  filePath: string,
  size: number,
): Promise<Buffer | { error: string }> {
  let handle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
  try {
    handle = await attachmentProbeFs.open(filePath, "r");
    const length = Math.min(Math.max(0, size), FILE_TYPE_SNIFF_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    return {
      error: `attachment file MIME read failed for ${filePath}: ${formatErrorMessage(error)}`,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function resolveAttachmentDelivery(params: {
  channel: string;
  captionFormat?: PluginSessionAttachmentCaptionFormat;
  channelHints?: PluginAttachmentChannelHints;
}): ResolvedAttachmentDelivery {
  const fallbackParseMode = captionFormatToParseMode(params.captionFormat);
  const channel = params.channel.trim().toLowerCase();
  if (channel === "telegram") {
    const hint = params.channelHints?.telegram;
    const parseMode =
      hint?.parseMode ?? (params.captionFormat === "plain" ? "HTML" : fallbackParseMode);
    const escapePlainHtmlCaption = params.captionFormat === "plain" && parseMode === "HTML";
    const forceDocumentMime = normalizeMimeType(hint?.forceDocumentMime);
    return {
      ...(parseMode ? { parseMode } : {}),
      ...(escapePlainHtmlCaption ? { escapePlainHtmlCaption: true } : {}),
      ...(hint?.disableNotification !== undefined
        ? { disableNotification: hint.disableNotification }
        : {}),
      ...(forceDocumentMime ? { forceDocumentMime } : {}),
    };
  }
  if (channel === "discord") {
    return fallbackParseMode ? { parseMode: fallbackParseMode } : {};
  }
  if (channel === "slack") {
    const hint = params.channelHints?.slack;
    const threadTs = normalizeOptionalString(hint?.threadTs);
    return {
      ...(fallbackParseMode ? { parseMode: fallbackParseMode } : {}),
      ...(threadTs ? { threadTs } : {}),
    };
  }
  return fallbackParseMode ? { parseMode: fallbackParseMode } : {};
}

async function validateAttachmentFiles(
  files: PluginSessionAttachmentParams["files"],
  maxBytes: number,
  options?: {
    forceDocumentMime?: string;
    config?: OpenClawConfig;
    sessionKey?: string;
  },
): Promise<string[] | { error: string }> {
  if (files.length > MAX_ATTACHMENT_FILES) {
    return { error: `at most ${MAX_ATTACHMENT_FILES} attachment files are allowed` };
  }
  const paths: string[] = [];
  let totalBytes = 0;
  for (const file of files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      return { error: "attachment file entry must be an object" };
    }
    const filePath = normalizeOptionalString((file as { path?: unknown }).path);
    if (!filePath) {
      return { error: "attachment file path is required" };
    }
    const resolvedPath = resolveAttachmentFilePath({
      filePath,
      config: options?.config,
      sessionKey: options?.sessionKey,
    });
    const info = await lstat(resolvedPath).catch(() => undefined);
    if (info?.isSymbolicLink()) {
      return { error: `attachment file symlinks are not allowed: ${resolvedPath}` };
    }
    if (!info?.isFile()) {
      return { error: `attachment file not found: ${resolvedPath}` };
    }
    if (info.size > maxBytes) {
      return { error: `attachment file exceeds ${maxBytes} bytes: ${resolvedPath}` };
    }
    if (options?.forceDocumentMime) {
      const fileBuffer = await readMimeSniffBuffer(resolvedPath, info.size);
      if (!Buffer.isBuffer(fileBuffer)) {
        return fileBuffer;
      }
      let detectedMime: string | undefined;
      try {
        detectedMime = normalizeMimeType(await detectMime({ buffer: fileBuffer }));
      } catch (error) {
        return {
          error:
            `attachment file MIME detection failed for ${filePath}: ` + formatErrorMessage(error),
        };
      }
      if (detectedMime !== options.forceDocumentMime) {
        return {
          error:
            `attachment file MIME mismatch for ${resolvedPath}: ` +
            `expected ${options.forceDocumentMime}, got ${detectedMime ?? "unknown"}`,
        };
      }
    }
    totalBytes += info.size;
    if (totalBytes > maxBytes) {
      return { error: `attachment files exceed ${maxBytes} bytes total` };
    }
    paths.push(resolvedPath);
  }
  return paths;
}

function resolveAttachmentFilePath(params: {
  filePath: string;
  config?: OpenClawConfig;
  sessionKey?: string;
}): string {
  const workspaceDir =
    params.sessionKey && params.config
      ? resolveAgentWorkspaceDir(params.config, resolveAgentIdFromSessionKey(params.sessionKey))
      : undefined;
  return resolvePathFromInput(params.filePath, resolveWorkspaceRoot(workspaceDir));
}

function normalizeOptionalThreadId(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return normalizeOptionalString(value);
}

export function resolveSessionAttachmentThreadId(params: {
  deliveryThreadId?: unknown;
  explicitThreadId?: unknown;
  fallbackThreadId?: unknown;
  hintThreadTs?: string;
}): string | number | undefined {
  return (
    params.hintThreadTs ??
    normalizeOptionalThreadId(params.explicitThreadId) ??
    normalizeOptionalThreadId(params.fallbackThreadId) ??
    normalizeOptionalThreadId(params.deliveryThreadId)
  );
}

export async function sendPluginSessionAttachment(
  params: PluginSessionAttachmentParams & { config?: OpenClawConfig; origin?: PluginOrigin },
): Promise<PluginSessionAttachmentResult> {
  if (params.origin !== "bundled") {
    return { ok: false, error: "session attachments are restricted to bundled plugins" };
  }
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return { ok: false, error: "sessionKey is required" };
  }
  if (!Array.isArray(params.files) || params.files.length === 0) {
    return { ok: false, error: "at least one attachment file is required" };
  }
  const maxBytes =
    typeof params.maxBytes === "number" && Number.isFinite(params.maxBytes)
      ? Math.min(DEFAULT_ATTACHMENT_MAX_BYTES, Math.max(1, Math.floor(params.maxBytes)))
      : DEFAULT_ATTACHMENT_MAX_BYTES;
  const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey, { cfg: params.config });
  if (!deliveryContext?.channel || !deliveryContext.to) {
    return { ok: false, error: `session has no active delivery route: ${sessionKey}` };
  }
  const normalizedChannel = normalizeMessageChannel(deliveryContext.channel);
  try {
    const deliveryPlugin =
      normalizedChannel && isDeliverableMessageChannel(normalizedChannel)
        ? ((await loadGetChannelPlugin())(normalizedChannel) as
            | AttachmentDeliveryChannelPlugin
            | undefined)
        : undefined;
    if (deliveryPlugin?.outbound?.deliveryMode === "gateway") {
      return {
        ok: false,
        error:
          `session attachments require direct outbound delivery for channel ` +
          `${deliveryContext.channel}; channel uses gateway delivery`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: `attachment delivery setup failed: ${formatErrorMessage(error)}`,
    };
  }
  const rawText = normalizeOptionalString(params.text) ?? "";
  const resolvedDelivery = resolveAttachmentDelivery({
    channel: deliveryContext.channel,
    captionFormat: params.captionFormat,
    channelHints: params.channelHints,
  });
  const validated = await validateAttachmentFiles(params.files, maxBytes, {
    forceDocumentMime: resolvedDelivery.forceDocumentMime,
    config: params.config,
    sessionKey,
  });
  if (!Array.isArray(validated)) {
    return { ok: false, error: validated.error };
  }
  const resolvedThreadId = resolveSessionAttachmentThreadId({
    deliveryThreadId: deliveryContext.threadId,
    explicitThreadId: params.threadId,
    fallbackThreadId: threadId,
    hintThreadTs: resolvedDelivery.threadTs,
  });
  let result: Awaited<ReturnType<SendMessage>>;
  try {
    const sendMessage = await loadSendMessage();
    result = await sendMessage({
      to: deliveryContext.to,
      content: resolvedDelivery.escapePlainHtmlCaption ? escapeHtmlText(rawText) : rawText,
      channel: deliveryContext.channel,
      accountId: deliveryContext.accountId,
      threadId: resolvedThreadId,
      requesterSessionKey: sessionKey,
      mediaUrls: validated,
      forceDocument: resolvedDelivery.forceDocumentMime ? true : params.forceDocument,
      bestEffort: false,
      cfg: params.config,
      ...(resolvedDelivery.parseMode ? { parseMode: resolvedDelivery.parseMode } : {}),
      ...(resolvedDelivery.disableNotification !== undefined
        ? { silent: resolvedDelivery.disableNotification }
        : {}),
    });
  } catch (error) {
    return { ok: false, error: `attachment delivery failed: ${formatErrorMessage(error)}` };
  }
  if (!result.result) {
    return { ok: false, error: "attachment delivery failed: no delivery result returned" };
  }
  return {
    ok: true,
    channel: result.channel,
    deliveredTo: deliveryContext.to,
    count: validated.length,
  };
}
