/**
 * Format a message_reference (from msg_elements[0]) into text for model context.
 *
 * This handles the cache-miss path: when a user quotes a message we haven't
 * cached in the ref-index store, we fall back to the msg_elements[0] data
 * pushed by the QQ platform.
 *
 * The heavy lifting (attachment download, STT, etc.) is delegated to an
 * injected `AttachmentProcessor` so this module stays framework-agnostic.
 */

import type { EngineLogger } from "../types.js";
import { parseFaceTags, buildAttachmentSummaries } from "../utils/text-parsing.js";
import { formatRefEntryForAgent } from "./format-ref-entry.js";
import type { RefAttachmentSummary } from "./types.js";

// ============ Injected dependency ============

/** Attachment download & voice transcription — injected from the outer layer. */
export interface AttachmentProcessor {
  processAttachments(
    attachments:
      | Array<{
          content_type: string;
          url: string;
          filename?: string;
          height?: number;
          width?: number;
          size?: number;
          voice_wav_url?: string;
          asr_refer_text?: string;
        }>
      | undefined,
    ctx: { appId: string; peerId?: string; cfg: unknown; log?: EngineLogger },
  ): Promise<{
    attachmentInfo: string;
    voiceTranscripts: string[];
    voiceTranscriptSources: string[];
    attachmentLocalPaths: Array<string | null>;
  }>;

  formatVoiceText(voiceTranscripts: string[]): string;
}

// ============ Public API ============

/**
 * Format a quoted message reference into human-readable text for model context.
 *
 * This mirrors the independent version's `formatMessageReferenceForAgent` —
 * processing attachments (download + STT) and combining them with parsed text.
 *
 * @param ref - The msg_elements[0] data from the QQ push event.
 * @param ctx - Context containing appId, peerId, config, and logger.
 * @param processor - Injected attachment processor (download + voice transcription).
 */
export async function formatMessageReferenceForAgent(
  ref:
    | {
        content?: string;
        attachments?: Array<{
          content_type: string;
          url: string;
          filename?: string;
          height?: number;
          width?: number;
          size?: number;
          voice_wav_url?: string;
          asr_refer_text?: string;
        }>;
      }
    | undefined,
  ctx: {
    appId: string;
    peerId?: string;
    cfg: unknown;
    log?: EngineLogger;
  },
  processor: AttachmentProcessor,
): Promise<string> {
  if (!ref) {
    return "";
  }

  // Process attachments (download images, transcribe voice, etc.)
  const processed = await processor.processAttachments(ref.attachments, ctx);
  const { attachmentInfo, voiceTranscripts, voiceTranscriptSources, attachmentLocalPaths } =
    processed;

  // Format voice transcript text
  const voiceText = processor.formatVoiceText(voiceTranscripts);

  // Parse QQ face tags into readable text
  const parsedContent = parseFaceTags(ref.content ?? "");

  // Combine text content with voice transcript and attachment info
  const userContent = voiceText
    ? (parsedContent.trim() ? `${parsedContent}\n${voiceText}` : voiceText) + attachmentInfo
    : parsedContent + attachmentInfo;

  // Build attachment summaries and inject voice transcripts
  const attSummaries = buildAttachmentSummaries(
    ref.attachments as Array<{
      content_type: string;
      url: string;
      filename?: string;
      voice_wav_url?: string;
    }>,
    attachmentLocalPaths,
  );
  if (attSummaries && voiceTranscripts.length > 0) {
    let voiceIdx = 0;
    for (const att of attSummaries) {
      if (att.type === "voice" && voiceIdx < voiceTranscripts.length) {
        att.transcript = voiceTranscripts[voiceIdx];
        if (voiceIdx < voiceTranscriptSources.length) {
          att.transcriptSource = voiceTranscriptSources[
            voiceIdx
          ] as RefAttachmentSummary["transcriptSource"];
        }
        voiceIdx++;
      }
    }
  }

  // Format using the same function as the cache-hit path
  const refEntry = {
    content: userContent.trim(),
    senderId: "",
    timestamp: Date.now(),
    attachments: attSummaries,
  };

  const formattedAttachments = formatRefEntryForAgent(refEntry);
  // If formatRefEntryForAgent already includes the content, use it directly.
  // Otherwise combine manually.
  if (formattedAttachments !== "[empty message]") {
    return formattedAttachments;
  }

  return userContent.trim() || "";
}
