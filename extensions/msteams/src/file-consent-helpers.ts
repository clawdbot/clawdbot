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

import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { buildFileConsentCard } from "./file-consent.js";
import { storePendingUploadFs } from "./pending-uploads-fs.js";
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

function buildConsentActivity(params: {
  media: FileConsentMedia;
  description?: string;
  uploadId: string;
}): Record<string, unknown> {
  const { media, description, uploadId } = params;
  const consentCard = buildFileConsentCard({
    filename: media.filename,
    description: description || `File: ${media.filename}`,
    sizeInBytes: media.buffer.length,
    context: { uploadId },
  });
  return {
    type: "message",
    attachments: [consentCard],
  };
}

/**
 * Prepare a FileConsentCard activity for large files or non-images in personal chats.
 * Returns the activity object and uploadId - caller is responsible for sending.
 *
 * This variant only writes to the in-memory store. Use it when the caller and
 * the `fileConsent/invoke` handler share the same process (for example the
 * messenger reply path). For proactive CLI sends where the invoke arrives in
 * a different process, use {@link prepareFileConsentActivityFs} instead.
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

  const activity = buildConsentActivity({ media, description, uploadId });
  return { activity, uploadId };
}

/**
 * Prepare a FileConsentCard activity and persist the pending upload to the
 * filesystem so a different process can read it when the user accepts.
 *
 * This is used by the proactive CLI `message send --media` path: the CLI
 * process sends the card and exits, but the `fileConsent/invoke` callback is
 * delivered to the long-lived gateway monitor process. The FS-backed store
 * bridges those two processes. The in-memory store is also populated so
 * same-process flows keep the fast path.
 */
export async function prepareFileConsentActivityFs(params: {
  media: FileConsentMedia;
  conversationId: string;
  description?: string;
}): Promise<FileConsentActivityResult> {
  const { media, conversationId, description } = params;

  // Populate the in-memory store first so the uploadId is consistent, then
  // mirror the same entry to the FS store under the same id so an invoke
  // handler in another process can find it.
  const uploadId = storePendingUpload({
    buffer: media.buffer,
    filename: media.filename,
    contentType: media.contentType,
    conversationId,
  });

  await storePendingUploadFs({
    id: uploadId,
    buffer: media.buffer,
    filename: media.filename,
    contentType: media.contentType,
    conversationId,
  });

  const activity = buildConsentActivity({ media, description, uploadId });
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
  const isPersonal = normalizeOptionalLowercaseString(params.conversationType) === "personal";
  const isImage = params.contentType?.startsWith("image/") ?? false;
  const isLargeFile = params.bufferSize >= params.thresholdBytes;
  return isPersonal && (isLargeFile || !isImage);
}
