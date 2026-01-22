/**
 * FileConsentCard utilities for MS Teams large file uploads (>4MB) in personal chats.
 *
 * Teams requires user consent before the bot can upload large files. This module provides
 * utilities for:
 * - Building FileConsentCard attachments (to request upload permission)
 * - Building FileInfoCard attachments (to confirm upload completion)
 * - Parsing fileConsent/invoke activities
 */

export interface FileConsentCardParams {
  filename: string;
  description?: string;
  sizeInBytes: number;
  /** Custom context data to include in the card (passed back in the invoke) */
  context?: Record<string, unknown>;
}

export interface FileInfoCardParams {
  filename: string;
  contentUrl: string;
  uniqueId: string;
  fileType: string;
}

/**
 * Build a FileConsentCard attachment for requesting upload permission.
 * Use this for files >= 4MB in personal (1:1) chats.
 */
export function buildFileConsentCard(params: FileConsentCardParams) {
  return {
    contentType: "application/vnd.microsoft.teams.card.file.consent",
    name: params.filename,
    content: {
      description: params.description ?? `File: ${params.filename}`,
      sizeInBytes: params.sizeInBytes,
      acceptContext: { filename: params.filename, ...params.context },
      declineContext: { filename: params.filename, ...params.context },
    },
  };
}

/**
 * Build a FileInfoCard attachment for confirming upload completion.
 * Send this after successfully uploading the file to the consent URL.
 */
export function buildFileInfoCard(params: FileInfoCardParams) {
  return {
    contentType: "application/vnd.microsoft.teams.card.file.info",
    contentUrl: params.contentUrl,
    name: params.filename,
    content: {
      uniqueId: params.uniqueId,
      fileType: params.fileType,
    },
  };
}

export interface FileConsentUploadInfo {
  name: string;
  uploadUrl: string;
  contentUrl: string;
  uniqueId: string;
  fileType: string;
}

export interface FileConsentResponse {
  action: "accept" | "decline";
  uploadInfo?: FileConsentUploadInfo;
  context?: Record<string, unknown>;
}

/**
 * Parse a fileConsent/invoke activity.
 * Returns null if the activity is not a file consent invoke.
 */
export function parseFileConsentInvoke(activity: {
  name?: string;
  value?: unknown;
}): FileConsentResponse | null {
  if (activity.name !== "fileConsent/invoke") return null;

  const value = activity.value as {
    type?: string;
    action?: string;
    uploadInfo?: FileConsentUploadInfo;
    context?: Record<string, unknown>;
  };

  if (value?.type !== "fileUpload") return null;

  return {
    action: value.action === "accept" ? "accept" : "decline",
    uploadInfo: value.uploadInfo,
    context: value.context,
  };
}

/**
 * Upload a file to the consent URL provided by Teams.
 * The URL is provided in the fileConsent/invoke response after user accepts.
 */
export async function uploadToConsentUrl(params: {
  url: string;
  buffer: Buffer;
  contentType?: string;
  fetchFn?: typeof fetch;
}): Promise<void> {
  const fetchFn = params.fetchFn ?? fetch;
  const res = await fetchFn(params.url, {
    method: "PUT",
    headers: {
      "Content-Type": params.contentType ?? "application/octet-stream",
      "Content-Range": `bytes 0-${params.buffer.length - 1}/${params.buffer.length}`,
    },
    body: new Uint8Array(params.buffer),
  });

  if (!res.ok) {
    throw new Error(`File upload to consent URL failed: ${res.status} ${res.statusText}`);
  }
}
