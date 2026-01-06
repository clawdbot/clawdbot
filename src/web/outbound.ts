import { randomUUID } from "node:crypto";

import { createSubsystemLogger, getChildLogger } from "../logging.js";
import { normalizePollInput, type PollInput } from "../polls.js";
import { toWhatsappJid } from "../utils.js";
import {
  type ActiveWebSendOptions,
  getActiveWebListener,
} from "./active-listener.js";
import { loadWebMedia } from "./media.js";

const outboundLog = createSubsystemLogger("gateway/providers/whatsapp").child(
  "outbound",
);

export async function sendMessageWhatsApp(
  to: string,
  body: string,
  options: { verbose: boolean; mediaUrl?: string; gifPlayback?: boolean },
): Promise<{ messageId: string; toJid: string }> {
  let text = body;
  const correlationId = randomUUID();
  const startedAt = Date.now();
  const active = getActiveWebListener();
  if (!active) {
    throw new Error(
      "No active gateway listener. Start the gateway before sending WhatsApp messages.",
    );
  }
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    to,
  });
  try {
    const jid = toWhatsappJid(to);
    let mediaBuffer: Buffer | undefined;
    let mediaType: string | undefined;
    if (options.mediaUrl) {
      const media = await loadWebMedia(options.mediaUrl);
      const caption = text || undefined;
      mediaBuffer = media.buffer;
      mediaType = media.contentType;
      if (media.kind === "audio") {
        // WhatsApp expects explicit opus codec for PTT voice notes.
        mediaType =
          media.contentType === "audio/ogg"
            ? "audio/ogg; codecs=opus"
            : (media.contentType ?? "application/octet-stream");
      } else if (media.kind === "video") {
        text = caption ?? "";
      } else if (media.kind === "image") {
        text = caption ?? "";
      } else {
        text = caption ?? "";
      }
    }
    outboundLog.info(
      `Sending message -> ${jid}${options.mediaUrl ? " (media)" : ""}`,
    );
    logger.info(
      { jid, hasMedia: Boolean(options.mediaUrl) },
      "sending message",
    );
    if (!active) throw new Error("Active web listener missing");
    await active.sendComposingTo(to);
    const sendOptions: ActiveWebSendOptions | undefined = options.gifPlayback
      ? { gifPlayback: true }
      : undefined;
    const result = sendOptions
      ? await active.sendMessage(to, text, mediaBuffer, mediaType, sendOptions)
      : await active.sendMessage(to, text, mediaBuffer, mediaType);
    const messageId =
      (result as { messageId?: string })?.messageId ?? "unknown";
    const durationMs = Date.now() - startedAt;
    outboundLog.info(
      `Sent message ${messageId} -> ${jid}${options.mediaUrl ? " (media)" : ""} (${durationMs}ms)`,
    );
    logger.info({ jid, messageId }, "sent message");
    return { messageId, toJid: jid };
  } catch (err) {
    logger.error(
      { err: String(err), to, hasMedia: Boolean(options.mediaUrl) },
      "failed to send via web session",
    );
    throw err;
  }
}
export async function sendPollWhatsApp(
  to: string,
  poll: PollInput,
  _options: { verbose: boolean },
): Promise<{ messageId: string; toJid: string }> {
  const correlationId = randomUUID();
  const startedAt = Date.now();
  const active = getActiveWebListener();
  if (!active) {
    throw new Error(
      "No active gateway listener. Start the gateway before sending WhatsApp polls.",
    );
  }
  const logger = getChildLogger({
    module: "web-outbound",
    correlationId,
    to,
  });
  try {
    const jid = toWhatsappJid(to);
    const normalized = normalizePollInput(poll, { maxOptions: 12 });
    outboundLog.info(`Sending poll -> ${jid}: "${normalized.question}"`);
    logger.info(
      {
        jid,
        question: normalized.question,
        optionCount: normalized.options.length,
        maxSelections: normalized.maxSelections,
      },
      "sending poll",
    );
    const result = await active.sendPoll(to, normalized);
    const messageId =
      (result as { messageId?: string })?.messageId ?? "unknown";
    const durationMs = Date.now() - startedAt;
    outboundLog.info(`Sent poll ${messageId} -> ${jid} (${durationMs}ms)`);
    logger.info({ jid, messageId }, "sent poll");
    return { messageId, toJid: jid };
  } catch (err) {
    logger.error(
      { err: String(err), to, question: poll.question },
      "failed to send poll via web session",
    );
    throw err;
  }
}
