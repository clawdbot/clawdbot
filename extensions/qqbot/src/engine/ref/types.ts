/**
 * Ref-index types shared between both plugin versions.
 *
 * These types define the structure of quoted-message metadata
 * persisted by the ref-index store.
 */

/** Summary stored for one quoted message. */
export interface RefIndexEntry {
  content: string;
  senderId: string;
  senderName?: string;
  timestamp: number;
  isBot?: boolean;
  attachments?: RefAttachmentSummary[];
}

/** Attachment summary persisted alongside a ref index entry. */
export interface RefAttachmentSummary {
  type: "image" | "voice" | "video" | "file" | "unknown";
  filename?: string;
  contentType?: string;
  transcript?: string;
  transcriptSource?: "stt" | "asr" | "tts" | "fallback";
  localPath?: string;
  url?: string;
}
