import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { generateSecureUuid } from "openclaw/plugin-sdk/core";
import { redactIdentifier } from "openclaw/plugin-sdk/logging-core";
import {
  convertMarkdownTables,
  resolveMarkdownTableMode,
} from "openclaw/plugin-sdk/markdown-table-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { normalizePollInput, type PollInput } from "openclaw/plugin-sdk/poll-runtime";
import { createSubsystemLogger, getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
  resolveWhatsAppMediaMaxBytes,
} from "./accounts.js";
import { getRegisteredWhatsAppConnectionController } from "./connection-controller-registry.js";
import type { ActiveWebListener, ActiveWebSendOptions } from "./inbound/types.js";
import {
  normalizeWhatsAppPayloadText,
  prepareWhatsAppOutboundMedia,
  resolveWhatsAppOutboundMediaUrls,
} from "./outbound-media-contract.js";
import { loadOutboundMediaFromUrl } from "./outbound-media.runtime.js";
import { markdownToWhatsApp, toWhatsappJid } from "./text-runtime.js";

const outboundLog = createSubsystemLogger("gateway/channels/whatsapp").child("outbound");

function resolveOutboundWhatsAppAccountId(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): string | undefined {
  const explicitAccountId = params.accountId?.trim();
  if (explicitAccountId) {
    return explicitAccountId;
  }
  return resolveDefaultWhatsAppAccountId(params.cfg);
}

function requireOutboundActiveWebListener(params: { cfg: OpenClawConfig; accountId?: string }): {
  accountId: string;
  listener: ActiveWebListener;
} {
  const accountId = resolveOutboundWhatsAppAccountId(params);
  const resolvedAccountId = accountId ?? resolveDefaultWhatsAppAccountId(params.cfg);
  const listener =
    getRegisteredWhatsAppConnectionController(resolvedAccountId)?.getActiveListener() ?? null;
  if (!listener) {
    throw new Error(
      `No active WhatsApp Web listener (account: ${resolvedAccountId}). Start the gateway, then link WhatsApp with: ${formatCliCommand(`openclaw channels login --channel whatsapp --account ${resolvedAccountId}`)}.`,
    );
  }
  return { accountId: resolvedAccountId, listener };
}

export async function sendMessageWhatsApp(
  to: string,
  body: string,
  options: {
    verbose: boolean;
    cfg: OpenClawConfig;
    mediaUrl?: string;
    mediaUrls?: readonly string[];
    mediaAccess?: {
      localRoots?: readonly string[];
      readFile?: (filePath: string) => Promise<Buffer>;
    };
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    gifPlayback?: boolean;
    audioAsVoice?: boolean;
    accountId?: string;
    quotedMessageKey?: {
      id: string;
      remoteJid: string;
      fromMe: boolean;
      participant?: string;
      messageText?: string;
    };
    preserveLeadingWhitespace?: boolean;
  },
): Promise<{ messageId: string; toJid: string }> {
  let text = options.preserveLeadingWhitespace ? body : normalizeWhatsAppPayloadText(body);
  const jid = toWhatsappJid(to);
  const mediaUrls = resolveWhatsAppOutboundMediaUrls(options);
  const primaryMediaUrl = mediaUrls[0];
  if (!text && !primaryMediaUrl) {
    return { messageId: "", toJid: jid };
  }
  const correlationId = generateSecureUuid();
  const startedAt = Date.now();
  const cfg = requireRuntimeConfig(options.cfg, "WhatsApp send");
  const { listener: active, accountId: resolvedAccountId } = requireOutboundActiveWebListener({
    cfg,
    accountId: options.accountId,
  });
  const account = resolveWhatsAppAccount({
    cfg,
    accountId: resolvedAccountId ?? options.accountId,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "whatsapp",
    accountId: resolvedAccountId ?? options.accountId,
  });
  text = convertMarkdownTables(text ?? "", tableMode);
  text = markdownToWhatsApp(text);
  const redactedTo = redactIdentifier(to);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    to: redactedTo,
  });
  try {
    const redactedJid = redactIdentifier(jid);
    let mediaBuffer: Buffer | undefined;
    let mediaType: string | undefined;
    let documentFileName: string | undefined;
    let visibleTextAfterVoice: string | undefined;
    if (primaryMediaUrl) {
      const media = await prepareWhatsAppOutboundMedia(
        await loadOutboundMediaFromUrl(primaryMediaUrl, {
          maxBytes: resolveWhatsAppMediaMaxBytes(account),
          mediaAccess: options.mediaAccess,
          mediaLocalRoots: options.mediaLocalRoots,
          mediaReadFile: options.mediaReadFile,
        }),
        primaryMediaUrl,
      );
      const caption = text || undefined;
      mediaBuffer = media.buffer;
      mediaType = media.mimetype;
      if (media.kind === "audio" && caption) {
        visibleTextAfterVoice = caption;
        text = "";
      } else if (media.kind === "document") {
        text = caption ?? "";
        documentFileName = media.fileName;
      } else {
        text = caption ?? "";
      }
    }
    outboundLog.info(`Sending message -> ${redactedJid}${primaryMediaUrl ? " (media)" : ""}`);
    logger.info({ jid: redactedJid, hasMedia: Boolean(primaryMediaUrl) }, "sending message");
    await active.sendComposingTo(to);
    const hasExplicitAccountId = Boolean(options.accountId?.trim());
    const accountId = hasExplicitAccountId ? resolvedAccountId : undefined;
    const sendOptions: ActiveWebSendOptions | undefined =
      options.gifPlayback || accountId || documentFileName || options.quotedMessageKey
        ? {
            ...(options.gifPlayback ? { gifPlayback: true } : {}),
            ...(documentFileName ? { fileName: documentFileName } : {}),
            ...(options.quotedMessageKey ? { quotedMessageKey: options.quotedMessageKey } : {}),
            accountId,
          }
        : undefined;
    const result = sendOptions
      ? await active.sendMessage(to, text, mediaBuffer, mediaType, sendOptions)
      : await active.sendMessage(to, text, mediaBuffer, mediaType);
    if (visibleTextAfterVoice) {
      if (sendOptions) {
        await active.sendMessage(to, visibleTextAfterVoice, undefined, undefined, sendOptions);
      } else {
        await active.sendMessage(to, visibleTextAfterVoice, undefined, undefined);
      }
    }
    const messageId = (result as { messageId?: string })?.messageId ?? "unknown";
    const durationMs = Date.now() - startedAt;
    outboundLog.info(
      `Sent message ${messageId} -> ${redactedJid}${primaryMediaUrl ? " (media)" : ""} (${durationMs}ms)`,
    );
    logger.info({ jid: redactedJid, messageId }, "sent message");
    return { messageId, toJid: jid };
  } catch (err) {
    logger.error(
      { err: String(err), to: redactedTo, hasMedia: Boolean(primaryMediaUrl) },
      "failed to send via web session",
    );
    throw err;
  }
}

export async function sendTypingWhatsApp(
  to: string,
  options: {
    cfg: OpenClawConfig;
    accountId?: string;
  },
): Promise<void> {
  const cfg = requireRuntimeConfig(options.cfg, "WhatsApp typing send");
  const { listener: active } = requireOutboundActiveWebListener({
    cfg,
    accountId: options.accountId,
  });
  await active.sendComposingTo(to);
}

export async function sendReactionWhatsApp(
  chatJid: string,
  messageId: string,
  emoji: string,
  options: {
    verbose: boolean;
    fromMe?: boolean;
    participant?: string;
    accountId?: string;
    cfg: OpenClawConfig;
  },
): Promise<void> {
  const correlationId = generateSecureUuid();
  const cfg = requireRuntimeConfig(options.cfg, "WhatsApp reaction");
  const { listener: active } = requireOutboundActiveWebListener({
    cfg,
    accountId: options.accountId,
  });
  const redactedChatJid = redactIdentifier(chatJid);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    chatJid: redactedChatJid,
    messageId,
  });
  try {
    const jid = toWhatsappJid(chatJid);
    const redactedJid = redactIdentifier(jid);
    outboundLog.info(`Sending reaction "${emoji}" -> message ${messageId}`);
    logger.info({ chatJid: redactedJid, messageId, emoji }, "sending reaction");
    await active.sendReaction(
      chatJid,
      messageId,
      emoji,
      options.fromMe ?? false,
      options.participant,
    );
    outboundLog.info(`Sent reaction "${emoji}" -> message ${messageId}`);
    logger.info({ chatJid: redactedJid, messageId, emoji }, "sent reaction");
  } catch (err) {
    logger.error(
      { err: String(err), chatJid: redactedChatJid, messageId, emoji },
      "failed to send reaction via web session",
    );
    throw err;
  }
}

export async function sendPollWhatsApp(
  to: string,
  poll: PollInput,
  options: { verbose: boolean; accountId?: string; cfg: OpenClawConfig },
): Promise<{ messageId: string; toJid: string }> {
  const correlationId = generateSecureUuid();
  const startedAt = Date.now();
  const cfg = requireRuntimeConfig(options.cfg, "WhatsApp poll");
  const { listener: active } = requireOutboundActiveWebListener({
    cfg,
    accountId: options.accountId,
  });
  const redactedTo = redactIdentifier(to);
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    to: redactedTo,
  });
  try {
    const jid = toWhatsappJid(to);
    const redactedJid = redactIdentifier(jid);
    const normalized = normalizePollInput(poll, { maxOptions: 12 });
    outboundLog.info(`Sending poll -> ${redactedJid}`);
    logger.info(
      {
        jid: redactedJid,
        optionCount: normalized.options.length,
        maxSelections: normalized.maxSelections,
      },
      "sending poll",
    );
    const result = await active.sendPoll(to, normalized);
    const messageId = (result as { messageId?: string })?.messageId ?? "unknown";
    const durationMs = Date.now() - startedAt;
    outboundLog.info(`Sent poll ${messageId} -> ${redactedJid} (${durationMs}ms)`);
    logger.info({ jid: redactedJid, messageId }, "sent poll");
    return { messageId, toJid: jid };
  } catch (err) {
    logger.error({ err: String(err), to: redactedTo }, "failed to send poll via web session");
    throw err;
  }
}
