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

export const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeContentType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function inferPlaceholder(params: {
  contentType?: string;
  fileName?: string;
  fileType?: string;
}): string {
  const mime = params.contentType?.toLowerCase() ?? "";
  const name = params.fileName?.toLowerCase() ?? "";
  const fileType = params.fileType?.toLowerCase() ?? "";

  const looksLikeImage =
    mime.startsWith("image/") || IMAGE_EXT_RE.test(name) || IMAGE_EXT_RE.test(`x.${fileType}`);

  return looksLikeImage ? "<media:image>" : "<media:document>";
}

export function isLikelyImageAttachment(att: MSTeamsAttachmentLike): boolean {
  const contentType = normalizeContentType(att.contentType) ?? "";
  const name = typeof att.name === "string" ? att.name : "";
  if (contentType.startsWith("image/")) return true;
  if (IMAGE_EXT_RE.test(name)) return true;

  if (
    contentType === "application/vnd.microsoft.teams.file.download.info" &&
    isRecord(att.content)
  ) {
    const fileType = typeof att.content.fileType === "string" ? att.content.fileType : "";
    if (fileType && IMAGE_EXT_RE.test(`x.${fileType}`)) return true;
    const fileName = typeof att.content.fileName === "string" ? att.content.fileName : "";
    if (fileName && IMAGE_EXT_RE.test(fileName)) return true;
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
  if (!isHtmlAttachment(att)) return undefined;
  if (typeof att.content === "string") return att.content;
  if (!isRecord(att.content)) return undefined;
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

function decodeDataImage(src: string): InlineImageCandidate | null {
  const match = /^data:(image\/[a-z0-9.+-]+)?(;base64)?,(.*)$/i.exec(src);
  if (!match) return null;
  const contentType = match[1]?.toLowerCase();
  const isBase64 = Boolean(match[2]);
  if (!isBase64) return null;
  const payload = match[3] ?? "";
  if (!payload) return null;
  try {
    const data = Buffer.from(payload, "base64");
    return { kind: "data", data, contentType, placeholder: "<media:image>" };
  } catch {
    return null;
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
): InlineImageCandidate[] {
  const out: InlineImageCandidate[] = [];
  for (const att of attachments) {
    const html = extractHtmlFromAttachment(att);
    if (!html) continue;
    IMG_SRC_RE.lastIndex = 0;
    let match: RegExpExecArray | null = IMG_SRC_RE.exec(html);
    while (match) {
      const src = match[1]?.trim();
      if (src && !src.startsWith("cid:")) {
        if (src.startsWith("data:")) {
          const decoded = decodeDataImage(src);
          if (decoded) out.push(decoded);
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
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "invalid-url";
  }
}

function normalizeAllowHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  if (trimmed === "*") return "*";
  return trimmed.replace(/^\*\.?/, "");
}

export function resolveAllowedHosts(input?: string[]): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    return DEFAULT_MEDIA_HOST_ALLOWLIST.slice();
  }
  const normalized = input.map(normalizeAllowHost).filter(Boolean);
  if (normalized.includes("*")) return ["*"];
  return normalized;
}

function isHostAllowed(host: string, allowlist: string[]): boolean {
  if (allowlist.includes("*")) return true;
  const normalized = host.toLowerCase();
  return allowlist.some((entry) => normalized === entry || normalized.endsWith(`.${entry}`));
}

export function isUrlAllowed(url: string, allowlist: string[]): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return isHostAllowed(parsed.hostname, allowlist);
  } catch {
    return false;
  }
}
