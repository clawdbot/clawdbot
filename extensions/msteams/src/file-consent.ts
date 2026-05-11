/**
 * FileConsentCard utilities for MS Teams large file uploads (>4MB) in personal chats.
 *
 * Teams requires user consent before the bot can upload large files. This module provides
 * utilities for:
 * - Building FileConsentCard attachments (to request upload permission)
 * - Building FileInfoCard attachments (to confirm upload completion)
 * - Parsing fileConsent/invoke activities
 */

import { lookup } from "node:dns/promises";
import { isPrivateIpAddress } from "openclaw/plugin-sdk/ssrf-policy";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildUserAgent } from "./user-agent.js";

/**
 * Allowlist of domains that are valid targets for file consent uploads.
 * These are the Microsoft/SharePoint domains that Teams legitimately provides
 * as upload destinations in the FileConsentCard flow.
 */
export const CONSENT_UPLOAD_HOST_ALLOWLIST = [
  "sharepoint.com",
  "sharepoint.us",
  "sharepoint.de",
  "sharepoint.cn",
  "sharepoint-df.com",
  "storage.live.com",
  "onedrive.com",
  "1drv.ms",
  "graph.microsoft.com",
  "graph.microsoft.us",
  "graph.microsoft.de",
  "graph.microsoft.cn",
] as const;

/**
 * Returns true if the given IPv4 or IPv6 address is private, internal, or
 * special-use and must never be reached via consent uploads.
 */
export const isPrivateOrReservedIP: (ip: string) => boolean = isPrivateIpAddress;

/**
 * Validate that a consent upload URL is safe to PUT to.
 * Checks:
 * 1. Protocol is HTTPS
 * 2. Hostname matches the consent upload allowlist
 * 3. Resolved IP is not in a private/reserved range (anti-SSRF)
 *
 * @throws Error if the URL fails validation
 */
export async function validateConsentUploadUrl(
  url: string,
  opts?: {
    allowlist?: readonly string[];
    resolveFn?: (hostname: string) => Promise<{ address: string } | { address: string }[]>;
  },
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Consent upload URL is not a valid URL");
  }

  // 1. Protocol check
  if (parsed.protocol !== "https:") {
    throw new Error(`Consent upload URL must use HTTPS, got ${parsed.protocol}`);
  }

  // 2. Hostname allowlist check
  const hostname = normalizeLowercaseStringOrEmpty(parsed.hostname);
  const allowlist = opts?.allowlist ?? CONSENT_UPLOAD_HOST_ALLOWLIST;
  const hostAllowed = allowlist.some(
    (entry) => hostname === entry || hostname.endsWith(`.${entry}`),
  );
  if (!hostAllowed) {
    throw new Error(`Consent upload URL hostname "${hostname}" is not in the allowed domains`);
  }

  // 3. DNS resolution — reject private/reserved IPs.
  // Check all resolved addresses to avoid SSRF bypass via mixed public/private answers.
  const resolveFn = opts?.resolveFn ?? ((name: string) => lookup(name, { all: true }));
  let resolved: { address: string }[];
  try {
    const result = await resolveFn(hostname);
    resolved = Array.isArray(result) ? result : [result];
  } catch {
    throw new Error(`Failed to resolve consent upload URL hostname "${hostname}"`);
  }

  for (const entry of resolved) {
    if (isPrivateOrReservedIP(entry.address)) {
      throw new Error(`Consent upload URL resolves to a private/reserved IP (${entry.address})`);
    }
  }
}

interface FileConsentCardParams {
  filename: string;
  description?: string;
  sizeInBytes: number;
  /** Custom context data to include in the card (passed back in the invoke) */
  context?: Record<string, unknown>;
}

interface FileInfoCardParams {
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

interface FileConsentUploadInfo {
  name: string;
  uploadUrl: string;
  contentUrl: string;
  uniqueId: string;
  fileType: string;
}

interface FileConsentResponse {
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
  if (activity.name !== "fileConsent/invoke") {
    return null;
  }

  const value = activity.value as {
    type?: string;
    action?: string;
    uploadInfo?: FileConsentUploadInfo;
    context?: Record<string, unknown>;
  };

  if (value?.type !== "fileUpload") {
    return null;
  }

  return {
    action: value.action === "accept" ? "accept" : "decline",
    uploadInfo: value.uploadInfo,
    context: value.context,
  };
}

/**
 * Upload a file to the consent URL provided by Teams.
 * The URL is provided in the fileConsent/invoke response after user accepts.
 *
 * @throws Error if the URL fails SSRF validation (non-HTTPS, disallowed host, private IP)
 */
export async function uploadToConsentUrl(params: {
  url: string;
  buffer: Buffer;
  contentType?: string;
  fetchFn?: typeof fetch;
  /** Override for testing — custom allowlist and DNS resolver */
  validationOpts?: {
    allowlist?: readonly string[];
    resolveFn?: (hostname: string) => Promise<{ address: string } | { address: string }[]>;
  };
}): Promise<void> {
  await validateConsentUploadUrl(params.url, params.validationOpts);

  const fetchFn = params.fetchFn ?? fetch;
  const res = await fetchFn(params.url, {
    method: "PUT",
    headers: {
      "User-Agent": buildUserAgent(),
      "Content-Type": params.contentType ?? "application/octet-stream",
      "Content-Range": `bytes 0-${params.buffer.length - 1}/${params.buffer.length}`,
    },
    body: new Uint8Array(params.buffer),
  });

  if (!res.ok) {
    throw new Error(`File upload to consent URL failed: ${res.status} ${res.statusText}`);
  }
}
