import { Buffer } from "node:buffer";
import { lookup } from "node:dns/promises";
import {
  buildHostnameAllowlistPolicyFromSuffixAllowlist,
  isHttpsUrlAllowedByHostnameSuffixAllowlist,
  isPrivateIpAddress,
  normalizeHostnameSuffixAllowlist,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-policy";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import type { MSTeamsAttachmentLike } from "./types.js";

type InlineImageCandidate =
  | {
      kind: "data";
      data: Buffer;
      contentType?: string;
      placeholder: string;
    }
  | {
      kind: "url";
      url: string;
      contentType?: string;
      fileHint?: string;
      placeholder: string;
    };

type InlineImageLimitOptions = {
  maxInlineBytes?: number;
  maxInlineTotalBytes?: number;
};

export const IMAGE_EXT_RE = /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;

export const IMG_SRC_RE = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
export const ATTACHMENT_TAG_RE = /<attachment[^>]+id=["']([^"']+)["'][^>]*>/gi;

export const DEFAULT_MEDIA_HOST_ALLOWLIST = [
  "graph.microsoft.com",
  "graph.microsoft.us",
  "graph.microsoft.de",
  "graph.microsoft.cn",
  "sharepoint.com",
  "sharepoint.us",
  "sharepoint.de",
  "sharepoint.cn",
  "sharepoint-df.com",
  "1drv.ms",
  "onedrive.com",
  "teams.microsoft.com",
  "teams.cdn.office.net",
  "statics.teams.cdn.office.net",
  "office.com",
  "office.net",
  // Azure Media Services / Skype CDN for clipboard-pasted images
  "asm.skype.com",
  "ams.skype.com",
  "media.ams.skype.com",
  // Bot Framework attachment URLs
  "trafficmanager.net",
  "blob.core.windows.net",
  "azureedge.net",
  "microsoft.com",
] as const;

export const DEFAULT_MEDIA_AUTH_HOST_ALLOWLIST = [
  "api.botframework.com",
  "botframework.com",
  // Bot Framework Service URL (smba.trafficmanager.net) used for outbound
  // replies and inbound attachment downloads (clipboard-pasted images).
  "smba.trafficmanager.net",
  "graph.microsoft.com",
  "graph.microsoft.us",
  "graph.microsoft.de",
  "graph.microsoft.cn",
] as const;

export const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
export { isRecord };

// Keep this local; importing the broad media-runtime SDK barrel pulls image/audio runtimes into
// hot MSTeams attachment tests for one tiny estimator.
export function estimateBase64DecodedBytes(base64: string): number {
  let effectiveLen = 0;
  for (let i = 0; i < base64.length; i += 1) {
    const code = base64.charCodeAt(i);
    if (code <= 0x20) {
      continue;
    }
    effectiveLen += 1;
  }

  if (effectiveLen === 0) {
    return 0;
  }

  let padding = 0;
  let end = base64.length - 1;
  while (end >= 0 && base64.charCodeAt(end) <= 0x20) {
    end -= 1;
  }
  if (end >= 0 && base64[end] === "=") {
    padding = 1;
    end -= 1;
    while (end >= 0 && base64.charCodeAt(end) <= 0x20) {
      end -= 1;
    }
    if (end >= 0 && base64[end] === "=") {
      padding = 2;
    }
  }

  const estimated = Math.floor((effectiveLen * 3) / 4) - padding;
  return Math.max(0, estimated);
}

/**
 * Host suffixes for SharePoint/OneDrive shared links that must be fetched via
 * the Graph `/shares/{shareId}/driveItem/content` endpoint instead of directly.
 *
 * Direct fetches of SharePoint/OneDrive shared URLs return empty/HTML landing
 * pages unless encoded as a Graph share id. See
 * https://learn.microsoft.com/en-us/graph/api/shares-get for the encoding.
 */
const GRAPH_SHARED_LINK_HOST_SUFFIXES = [
  ".sharepoint.com",
  ".sharepoint.us",
  ".sharepoint.de",
  ".sharepoint.cn",
  ".sharepoint-df.com",
  "1drv.ms",
  "onedrive.live.com",
  "onedrive.com",
] as const;

/**
 * Returns true when the URL points at a SharePoint or OneDrive host whose
 * shared-link content must be fetched through the Graph shares API rather
 * than directly.
 */
export function isGraphSharedLinkUrl(url: string): boolean {
  let host: string;
  try {
    host = normalizeLowercaseStringOrEmpty(new URL(url).hostname);
  } catch {
    return false;
  }
  if (!host) {
    return false;
  }
  return GRAPH_SHARED_LINK_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(suffix));
}

/**
 * Encode a SharePoint/OneDrive URL as a Graph shareId using the documented
 * `u!` + base64url (no padding) scheme:
 * https://learn.microsoft.com/en-us/graph/api/shares-get#encoding-sharing-urls
 */
export function encodeGraphShareId(url: string): string {
  // Buffer.from(...).toString("base64url") already returns base64url without
  // padding, matching the Graph spec exactly.
  return `u!${Buffer.from(url, "utf8").toString("base64url")}`;
}

/**
 * When `url` is a SharePoint/OneDrive shared link, return the matching
 * `GET /shares/{shareId}/driveItem/content` URL that actually yields the file
 * bytes. Returns `undefined` for non-shared-link URLs so callers can fall
 * through to the existing fetch path.
 */
export function tryBuildGraphSharesUrlForSharedLink(url: string): string | undefined {
  if (!isGraphSharedLinkUrl(url)) {
    return undefined;
  }
  return `${GRAPH_ROOT}/shares/${encodeGraphShareId(url)}/driveItem/content`;
}

export function readNestedString(value: unknown, keys: Array<string | number>): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key as keyof typeof current];
  }
  return normalizeOptionalString(current);
}

export function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "object" && input && "url" in input && typeof input.url === "string") {
    return input.url;
  }
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}

export function normalizeContentType(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function inferPlaceholder(params: {
  contentType?: string;
  fileName?: string;
  fileType?: string;
}): string {
  const mime = normalizeLowercaseStringOrEmpty(params.contentType ?? "");
  const name = normalizeLowercaseStringOrEmpty(params.fileName ?? "");
  const fileType = normalizeLowercaseStringOrEmpty(params.fileType ?? "");

  const looksLikeImage =
    mime.startsWith("image/") || IMAGE_EXT_RE.test(name) || IMAGE_EXT_RE.test(`x.${fileType}`);

  return looksLikeImage ? "<media:image>" : "<media:document>";
}

export function isLikelyImageAttachment(att: MSTeamsAttachmentLike): boolean {
  const contentType = normalizeContentType(att.contentType) ?? "";
  const name = typeof att.name === "string" ? att.name : "";
  if (contentType.startsWith("image/")) {
    return true;
  }
  if (IMAGE_EXT_RE.test(name)) {
    return true;
  }

  if (
    contentType === "application/vnd.microsoft.teams.file.download.info" &&
    isRecord(att.content)
  ) {
    const fileType = typeof att.content.fileType === "string" ? att.content.fileType : "";
    if (fileType && IMAGE_EXT_RE.test(`x.${fileType}`)) {
      return true;
    }
    const fileName = typeof att.content.fileName === "string" ? att.content.fileName : "";
    if (fileName && IMAGE_EXT_RE.test(fileName)) {
      return true;
    }
  }

  return false;
}

/**
 * Returns true if the attachment can be downloaded (any file type).
 * Used when downloading all files, not just images.
 */
export function isDownloadableAttachment(att: MSTeamsAttachmentLike): boolean {
  const contentType = normalizeContentType(att.contentType) ?? "";

  // Teams file download info always has a downloadUrl
  if (
    contentType === "application/vnd.microsoft.teams.file.download.info" &&
    isRecord(att.content) &&
    typeof att.content.downloadUrl === "string"
  ) {
    return true;
  }

  // Any attachment with a contentUrl can be downloaded
  if (typeof att.contentUrl === "string" && att.contentUrl.trim()) {
    return true;
  }

  return false;
}

function isHtmlAttachment(att: MSTeamsAttachmentLike): boolean {
  const contentType = normalizeContentType(att.contentType) ?? "";
  return contentType.startsWith("text/html");
}

export function extractHtmlFromAttachment(att: MSTeamsAttachmentLike): string | undefined {
  if (!isHtmlAttachment(att)) {
    return undefined;
  }
  if (typeof att.content === "string") {
    return att.content;
  }
  if (!isRecord(att.content)) {
    return undefined;
  }
  const text =
    typeof att.content.text === "string"
      ? att.content.text
      : typeof att.content.body === "string"
        ? att.content.body
        : typeof att.content.content === "string"
          ? att.content.content
          : undefined;
  return text;
}

function isLikelyBase64Payload(value: string): boolean {
  return /^[A-Za-z0-9+/=\r\n]+$/.test(value);
}

function decodeDataImageWithLimits(
  src: string,
  opts: { maxInlineBytes?: number },
): { candidate: InlineImageCandidate | null; estimatedBytes: number } {
  const match = /^data:(image\/[a-z0-9.+-]+)?(;base64)?,(.*)$/i.exec(src);
  if (!match) {
    return { candidate: null, estimatedBytes: 0 };
  }
  const contentType = normalizeLowercaseStringOrEmpty(match[1] ?? "");
  const isBase64 = Boolean(match[2]);
  if (!isBase64) {
    return { candidate: null, estimatedBytes: 0 };
  }
  const payload = match[3] ?? "";
  if (!payload || !isLikelyBase64Payload(payload)) {
    return { candidate: null, estimatedBytes: 0 };
  }

  const estimatedBytes = estimateBase64DecodedBytes(payload);
  if (estimatedBytes <= 0) {
    return { candidate: null, estimatedBytes: 0 };
  }
  if (typeof opts.maxInlineBytes === "number" && estimatedBytes > opts.maxInlineBytes) {
    return { candidate: null, estimatedBytes };
  }

  try {
    const data = Buffer.from(payload, "base64");
    return {
      candidate: { kind: "data", data, contentType, placeholder: "<media:image>" },
      estimatedBytes,
    };
  } catch {
    return { candidate: null, estimatedBytes: 0 };
  }
}

function fileHintFromUrl(src: string): string | undefined {
  try {
    const url = new URL(src);
    const name = url.pathname.split("/").pop();
    return name || undefined;
  } catch {
    return undefined;
  }
}

export function extractInlineImageCandidates(
  attachments: MSTeamsAttachmentLike[],
  limits?: InlineImageLimitOptions,
): InlineImageCandidate[] {
  const out: InlineImageCandidate[] = [];
  let totalEstimatedInlineBytes = 0;
  outerLoop: for (const att of attachments) {
    const html = extractHtmlFromAttachment(att);
    if (!html) {
      continue;
    }
    IMG_SRC_RE.lastIndex = 0;
    let match: RegExpExecArray | null = IMG_SRC_RE.exec(html);
    while (match) {
      const src = match[1]?.trim();
      if (src && !src.startsWith("cid:")) {
        if (src.startsWith("data:")) {
          const { candidate: decoded, estimatedBytes } = decodeDataImageWithLimits(src, {
            maxInlineBytes: limits?.maxInlineBytes,
          });
          if (decoded) {
            const nextTotal = totalEstimatedInlineBytes + estimatedBytes;
            if (
              typeof limits?.maxInlineTotalBytes === "number" &&
              nextTotal > limits.maxInlineTotalBytes
            ) {
              break outerLoop;
            }
            totalEstimatedInlineBytes = nextTotal;
            out.push(decoded);
          }
        } else {
          out.push({
            kind: "url",
            url: src,
            fileHint: fileHintFromUrl(src),
            placeholder: "<media:image>",
          });
        }
      }
      match = IMG_SRC_RE.exec(html);
    }
  }
  return out;
}

export function safeHostForUrl(url: string): string {
  try {
    return normalizeLowercaseStringOrEmpty(new URL(url).hostname);
  } catch {
    return "invalid-url";
  }
}

export function resolveAllowedHosts(input?: string[]): string[] {
  return normalizeHostnameSuffixAllowlist(input, DEFAULT_MEDIA_HOST_ALLOWLIST);
}

export function resolveAuthAllowedHosts(input?: string[]): string[] {
  return normalizeHostnameSuffixAllowlist(input, DEFAULT_MEDIA_AUTH_HOST_ALLOWLIST);
}

export type MSTeamsAttachmentFetchPolicy = {
  allowHosts: string[];
  authAllowHosts: string[];
};

/**
 * Logger surface for attachment download errors. Structured so callers can
 * pass `MSTeamsMonitorLogger` directly without adapters. Optional `warn`/
 * `error` methods prevent silent swallowing of fetch failures — see issue
 * #63396 where empty `catch {}` blocks hid a Node 24+ undici incompatibility.
 */
export type MSTeamsAttachmentDownloadLogger = {
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
};

export type MSTeamsAttachmentResolveFn = (hostname: string) => Promise<{ address: string }>;

export function resolveAttachmentFetchPolicy(params?: {
  allowHosts?: string[];
  authAllowHosts?: string[];
}): MSTeamsAttachmentFetchPolicy {
  return {
    allowHosts: resolveAllowedHosts(params?.allowHosts),
    authAllowHosts: resolveAuthAllowedHosts(params?.authAllowHosts),
  };
}

export function isUrlAllowed(url: string, allowlist: string[]): boolean {
  return isHttpsUrlAllowedByHostnameSuffixAllowlist(url, allowlist);
}

export function applyAuthorizationHeaderForUrl(params: {
  headers: Headers;
  url: string;
  authAllowHosts: string[];
  bearerToken?: string;
}): void {
  if (!params.bearerToken) {
    params.headers.delete("Authorization");
    return;
  }
  if (isUrlAllowed(params.url, params.authAllowHosts)) {
    params.headers.set("Authorization", `Bearer ${params.bearerToken}`);
    return;
  }
  params.headers.delete("Authorization");
}

export function resolveMediaSsrfPolicy(allowHosts: string[]): SsrFPolicy | undefined {
  return buildHostnameAllowlistPolicyFromSuffixAllowlist(allowHosts);
}

/**
 * Returns true if the given IPv4 or IPv6 address is in a private, loopback,
 * or link-local range that must never be reached from media downloads.
 *
 * Delegates to the SDK's `isPrivateIpAddress` which handles IPv4-mapped IPv6,
 * expanded notation, NAT64, 6to4, Teredo, octal IPv4, and fails closed on
 * parse errors.
 */
export const isPrivateOrReservedIP: (ip: string) => boolean = isPrivateIpAddress;

/**
 * Resolve a hostname via DNS and reject private/reserved IPs.
 * Throws if the resolved IP is private or resolution fails.
 */
export async function resolveAndValidateIP(
  hostname: string,
  resolveFn?: MSTeamsAttachmentResolveFn,
): Promise<string> {
  const resolve = resolveFn ?? lookup;
  let resolved: { address: string };
  try {
    resolved = await resolve(hostname);
  } catch {
    throw new Error(`DNS resolution failed for "${hostname}"`);
  }
  if (isPrivateOrReservedIP(resolved.address)) {
    throw new Error(`Hostname "${hostname}" resolves to private/reserved IP (${resolved.address})`);
  }
  return resolved.address;
}

/** Maximum number of redirects to follow in safeFetch. */
const MAX_SAFE_REDIRECTS = 5;

/**
 * Fetch a URL with redirect: "manual", validating each redirect target
 * against the hostname allowlist and optional DNS-resolved IP (anti-SSRF).
 *
 * This prevents:
 * - Auto-following redirects to non-allowlisted hosts
 * - DNS rebinding attacks when a lookup function is provided
 */
export async function safeFetch(params: {
  url: string;
  allowHosts: string[];
  /**
   * Optional allowlist for forwarding Authorization across redirects.
   * When set, Authorization is stripped before following redirects to hosts
   * outside this list.
   */
  authorizationAllowHosts?: string[];
  fetchFn?: typeof fetch;
  requestInit?: RequestInit;
  resolveFn?: MSTeamsAttachmentResolveFn;
}): Promise<Response> {
  const fetchFn = params.fetchFn ?? fetch;
  const resolveFn = params.resolveFn ?? lookup;
  const hasDispatcher = Boolean(
    params.requestInit &&
    typeof params.requestInit === "object" &&
    "dispatcher" in (params.requestInit as Record<string, unknown>),
  );
  const currentHeaders = new Headers(params.requestInit?.headers);
  let currentUrl = params.url;

  if (!isUrlAllowed(currentUrl, params.allowHosts)) {
    throw new Error(`Initial download URL blocked: ${currentUrl}`);
  }

  if (resolveFn) {
    try {
      const initialHost = new URL(currentUrl).hostname;
      await resolveAndValidateIP(initialHost, resolveFn);
    } catch {
      throw new Error(`Initial download URL blocked: ${currentUrl}`);
    }
  }

  for (let i = 0; i <= MAX_SAFE_REDIRECTS; i++) {
    const res = await fetchFn(currentUrl, {
      ...params.requestInit,
      headers: currentHeaders,
      redirect: "manual",
    });

    if (![301, 302, 303, 307, 308].includes(res.status)) {
      return res;
    }

    const location = res.headers.get("location");
    if (!location) {
      return res;
    }

    let redirectUrl: string;
    try {
      redirectUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new Error(`Invalid redirect URL: ${location}`);
    }

    // Validate redirect target against hostname allowlist
    if (!isUrlAllowed(redirectUrl, params.allowHosts)) {
      throw new Error(`Media redirect target blocked by allowlist: ${redirectUrl}`);
    }

    // Prevent credential bleed: only keep Authorization on redirect hops that
    // are explicitly auth-allowlisted.
    if (
      currentHeaders.has("authorization") &&
      params.authorizationAllowHosts &&
      !isUrlAllowed(redirectUrl, params.authorizationAllowHosts)
    ) {
      currentHeaders.delete("authorization");
    }

    // When a pinned dispatcher is already injected by an upstream guard
    // (for example fetchWithSsrFGuard), let that guard own redirect handling
    // after this allowlist validation step.
    if (hasDispatcher) {
      return res;
    }

    // Validate redirect target's resolved IP
    if (resolveFn) {
      const redirectHost = new URL(redirectUrl).hostname;
      await resolveAndValidateIP(redirectHost, resolveFn);
    }

    currentUrl = redirectUrl;
  }

  throw new Error(`Too many redirects (>${MAX_SAFE_REDIRECTS})`);
}

export async function safeFetchWithPolicy(params: {
  url: string;
  policy: MSTeamsAttachmentFetchPolicy;
  fetchFn?: typeof fetch;
  requestInit?: RequestInit;
  resolveFn?: MSTeamsAttachmentResolveFn;
}): Promise<Response> {
  return await safeFetch({
    url: params.url,
    allowHosts: params.policy.allowHosts,
    authorizationAllowHosts: params.policy.authAllowHosts,
    fetchFn: params.fetchFn,
    requestInit: params.requestInit,
    resolveFn: params.resolveFn,
  });
}
