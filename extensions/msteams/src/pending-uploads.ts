/**
 * In-memory storage for files awaiting user consent in the FileConsentCard flow.
 *
 * When sending large files (>=4MB) in personal chats, Teams requires user consent
 * before upload. This module stores the file data temporarily until the user
 * accepts or declines, or until the TTL expires.
 */

import crypto from "node:crypto";

export interface PendingUpload {
  id: string;
  buffer: Buffer;
  filename: string;
  contentType?: string;
  conversationId: string;
  createdAt: number;
}

const pendingUploads = new Map<string, PendingUpload>();

/** TTL for pending uploads: 5 minutes */
const PENDING_UPLOAD_TTL_MS = 5 * 60 * 1000;

/**
 * Store a file pending user consent.
 * Returns the upload ID to include in the FileConsentCard context.
 */
export function storePendingUpload(
  upload: Omit<PendingUpload, "id" | "createdAt">,
): string {
  const id = crypto.randomUUID();
  const entry: PendingUpload = {
    ...upload,
    id,
    createdAt: Date.now(),
  };
  pendingUploads.set(id, entry);

  // Auto-cleanup after TTL
  setTimeout(() => {
    pendingUploads.delete(id);
  }, PENDING_UPLOAD_TTL_MS);

  return id;
}

/**
 * Retrieve a pending upload by ID.
 * Returns undefined if not found or expired.
 */
export function getPendingUpload(id?: string): PendingUpload | undefined {
  if (!id) return undefined;
  const entry = pendingUploads.get(id);
  if (!entry) return undefined;

  // Check if expired (in case timeout hasn't fired yet)
  if (Date.now() - entry.createdAt > PENDING_UPLOAD_TTL_MS) {
    pendingUploads.delete(id);
    return undefined;
  }

  return entry;
}

/**
 * Remove a pending upload (after successful upload or user decline).
 */
export function removePendingUpload(id?: string): void {
  if (id) {
    pendingUploads.delete(id);
  }
}

/**
 * Get the count of pending uploads (for monitoring/debugging).
 */
export function getPendingUploadCount(): number {
  return pendingUploads.size;
}

/**
 * Clear all pending uploads (for testing).
 */
export function clearPendingUploads(): void {
  pendingUploads.clear();
}
