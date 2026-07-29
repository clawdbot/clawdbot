/**
 * RefIdx persistence stage — writes the current message into the shared
 * `refIndex` cache so future quote resolutions can find it.
 *
 * The stage also attaches voice transcripts (and their source) onto the
 * cached attachment summaries so replies-to-this-message can render the
 * original audio content inline instead of just a file handle.
 *
 * Pure data pipeline (no network I/O). Sync return value.
 */

import { setRefIndex } from "../../ref/store.js";
import { buildAttachmentSummaries } from "../../utils/text-parsing.js";
import type { ProcessedAttachments } from "../inbound-attachments.js";
import type { QueuedMessage } from "../message-queue.js";

/**
 * Cache the current message under `msgIdx` (or the fallback `refIdx`
 * returned by the typing-indicator call) so later quotes resolve.
 *
 * No-op when neither id is available.
 */
export function writeRefIndex(params: {
  event: QueuedMessage;
  parsedContent: string;
  processed: ProcessedAttachments;
  /** Optional refIdx returned by `InputNotify` — used when `msgIdx` is missing. */
  inputNotifyRefIdx?: string;
}): void {
  const { event, parsedContent, processed, inputNotifyRefIdx } = params;

  const currentMsgIdx = event.msgIdx ?? inputNotifyRefIdx;
  if (!currentMsgIdx) {
    return;
  }

  const attSummaries = buildAttachmentSummaries(event.attachments, processed.attachmentLocalPaths);
  if (attSummaries && processed.voiceTranscripts.length > 0) {
    let voiceIdx = 0;
    for (const att of attSummaries) {
      if (att.type === "voice" && voiceIdx < processed.voiceTranscripts.length) {
        att.transcript = processed.voiceTranscripts[voiceIdx];
        if (voiceIdx < processed.voiceTranscriptSources.length) {
          att.transcriptSource = processed.voiceTranscriptSources[voiceIdx] as
            | "stt"
            | "asr"
            | "tts"
            | "fallback";
        }
        voiceIdx++;
      }
    }
  }

  setRefIndex(currentMsgIdx, {
    content: parsedContent,
    senderId: event.senderId,
    senderName: event.senderName,
    timestamp: new Date(event.timestamp).getTime(),
    attachments: attSummaries,
  });
}
