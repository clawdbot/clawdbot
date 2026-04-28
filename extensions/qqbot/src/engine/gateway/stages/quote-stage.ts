/**
 * Quote stage — resolve the quoted-reply (`refMsgIdx`) if any.
 *
 * Three-level fallback mirrors the standalone build:
 *   1. RefIndex cache hit → rich ReplyToInfo
 *   2. `msg_elements[0]` present → re-process the quoted body
 *   3. Otherwise → id-only placeholder so the pipeline still knows it's a reply
 */

import {
  formatMessageReferenceForAgent,
  type AttachmentProcessor,
} from "../../ref/format-message-ref.js";
import { formatRefEntryForAgent, getRefIndex } from "../../ref/store.js";
import { MSG_TYPE_QUOTE } from "../../utils/text-parsing.js";
import { formatVoiceText } from "../../utils/voice-text.js";
import { processAttachments } from "../inbound-attachments.js";
import type { InboundPipelineDeps, ReplyToInfo } from "../inbound-context.js";
import type { QueuedMessage } from "../message-queue.js";

/**
 * Resolve the quote metadata for an inbound event.
 *
 * Returns `undefined` when the event is not a reply at all.
 */
export async function resolveQuote(
  event: QueuedMessage,
  deps: InboundPipelineDeps,
): Promise<ReplyToInfo | undefined> {
  if (!event.refMsgIdx) {
    return undefined;
  }

  const { account, log } = deps;

  // ---- Layer 1: cache hit ----
  const refEntry = getRefIndex(event.refMsgIdx);
  if (refEntry) {
    log?.debug?.(
      `Quote detected via refMsgIdx cache: refMsgIdx=${event.refMsgIdx}, sender=${refEntry.senderName ?? refEntry.senderId}`,
    );
    return {
      id: event.refMsgIdx,
      body: formatRefEntryForAgent(refEntry),
      sender: refEntry.senderName ?? refEntry.senderId,
      isQuote: true,
    };
  }

  // ---- Layer 2: fall back to msg_elements[0] if this is a quote type ----
  if (event.msgType === MSG_TYPE_QUOTE && event.msgElements?.[0]) {
    try {
      const refElement = event.msgElements[0];
      const refData = {
        content: refElement.content ?? "",
        attachments: refElement.attachments,
      };
      const attachmentProcessor: AttachmentProcessor = {
        processAttachments: async (atts, refCtx) => {
          const result = await processAttachments(
            atts as Array<{
              content_type: string;
              url: string;
              filename?: string;
              voice_wav_url?: string;
              asr_refer_text?: string;
            }>,
            {
              accountId: account.accountId,
              cfg: refCtx.cfg,
              audioConvert: deps.adapters.audioConvert,
              log: refCtx.log,
            },
          );
          return {
            attachmentInfo: result.attachmentInfo,
            voiceTranscripts: result.voiceTranscripts,
            voiceTranscriptSources: result.voiceTranscriptSources,
            attachmentLocalPaths: result.attachmentLocalPaths,
          };
        },
        formatVoiceText: (transcripts) => formatVoiceText(transcripts),
      };
      const refPeerId =
        event.type === "group" && event.groupOpenid ? event.groupOpenid : event.senderId;
      const refBody = await formatMessageReferenceForAgent(
        refData,
        { appId: account.appId, peerId: refPeerId, cfg: account.config, log },
        attachmentProcessor,
      );
      log?.debug?.(
        `Quote detected via msg_elements[0] (cache miss): id=${event.refMsgIdx}, content="${(refBody ?? "").slice(0, 80)}..."`,
      );
      return {
        id: event.refMsgIdx,
        body: refBody || undefined,
        isQuote: true,
      };
    } catch (refErr) {
      log?.error(`Failed to format quoted message from msg_elements: ${String(refErr)}`);
    }
  } else {
    log?.debug?.(
      `Quote detected but no cache and msgType=${event.msgType}: refMsgIdx=${event.refMsgIdx}`,
    );
  }

  // ---- Layer 3: id-only placeholder ----
  return {
    id: event.refMsgIdx,
    isQuote: true,
  };
}
