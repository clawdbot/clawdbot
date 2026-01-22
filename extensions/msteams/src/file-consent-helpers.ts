/**
 * Shared helpers for FileConsentCard flow in MSTeams.
 *
 * FileConsentCard is required for:
 * - Personal (1:1) chats with large files (>=4MB)
 * - Personal chats with non-image files (PDFs, documents, etc.)
 *
 * This module consolidates the logic used by both send.ts (proactive sends)
 * and messenger.ts (reply path) to avoid duplication.
 */

import { buildFileConsentCard } from "./file-consent.js";
import { storePendingUpload } from "./pending-uploads.js";

export type FileConsentMedia = {
  buffer: Buffer;
  filename: string;
  contentType?: string;
};

export type FileConsentActivityResult = {
  activity: Record<string, unknown>;
  uploadId: string;
};

/**
 * Prepare a FileConsentCard activity for large files or non-images in personal chats.
 * Returns the activity object and uploadId - caller is responsible for sending.
 */
export function prepareFileConsentActivity(params: {
  media: FileConsentMedia;
  conversationId: string;
  description?: string;
}): FileConsentActivityResult {
  const { media, conversationId, description } = params;

  const uploadId = storePendingUpload({
    buffer: media.buffer,
    filename: media.filename,
    contentType: media.contentType,
    conversationId,
  });

  const consentCard = buildFileConsentCard({
    filename: media.filename,
    description: description || `File: ${media.filename}`,
    sizeInBytes: media.buffer.length,
    context: { uploadId },
  });

  const activity: Record<string, unknown> = {
    type: "message",
    attachments: [consentCard],
  };

  return { activity, uploadId };
}

/**
 * Check if a file requires FileConsentCard flow.
 * True for: personal chat AND (large file OR non-image)
 */
export function requiresFileConsent(params: {
  conversationType: string | undefined;
  contentType: string | undefined;
  bufferSize: number;
  thresholdBytes: number;
}): boolean {
  const isPersonal = params.conversationType?.toLowerCase() === "personal";
  const isImage = params.contentType?.startsWith("image/") ?? false;
  const isLargeFile = params.bufferSize >= params.thresholdBytes;
  return isPersonal && (isLargeFile || !isImage);
}
