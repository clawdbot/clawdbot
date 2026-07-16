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
  /** Activity ID of the original FileConsentCard, used to replace it after upload */
  consentCardActivityId?: string;
  createdAt: number;
}

const pendingUploads = new Map<string, PendingUpload>();
/** Timer handles keyed by upload ID, cleared on explicit removal to prevent ghost cleanup */
const pendingUploadTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** TTL for pending uploads: 5 minutes */
const PENDING_UPLOAD_TTL_MS = 5 * 60 * 1000;

/**
 * Store a file pending user consent.
 * Returns the upload ID to include in the FileConsentCard context.
 */
export function storePendingUpload(upload: Omit<PendingUpload, "id" | "createdAt">): string {
  const id = crypto.randomUUID();
  const entry: PendingUpload = {
    ...upload,
    id,
    createdAt: Date.now(),
  };
  pendingUploads.set(id, entry);

  // Auto-cleanup after TTL; timer ref stored so removePendingUpload can cancel it
  const timer = setTimeout(() => {
    pendingUploads.delete(id);
    pendingUploadTimers.delete(id);
  }, PENDING_UPLOAD_TTL_MS);
  pendingUploadTimers.set(id, timer);

  return id;
}

/**
 * Retrieve a pending upload by ID.
 * Returns undefined if not found or expired.
 */
export function getPendingUpload(id?: string): PendingUpload | undefined {
  if (!id) {
    return undefined;
  }
  const entry = pendingUploads.get(id);
  if (!entry) {
    return undefined;
  }

  // Check if expired (in case timeout hasn't fired yet)
  if (Date.now() - entry.createdAt > PENDING_UPLOAD_TTL_MS) {
    pendingUploads.delete(id);
    const timer = pendingUploadTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      pendingUploadTimers.delete(id);
    }
    return undefined;
  }

  return entry;
}

/**
 * Remove a pending upload (after successful upload or user decline).
 * Also clears the TTL timer to prevent ghost Map deletions.
 */
export function removePendingUpload(id?: string): void {
  if (id) {
    pendingUploads.delete(id);
    const timer = pendingUploadTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      pendingUploadTimers.delete(id);
    }
  }
}

/**
 * Set the consent card activity ID on an existing pending upload.
 * Called after the FileConsentCard is sent and we know its activity ID.
 */
export function setPendingUploadActivityId(uploadId: string, activityId: string): void {
  const entry = pendingUploads.get(uploadId);
  if (entry) {
    entry.consentCardActivityId = activityId;
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
  for (const timer of pendingUploadTimers.values()) {
    clearTimeout(timer);
  }
  pendingUploadTimers.clear();
  pendingUploads.clear();
}
