import { kindFromMime } from "@openclaw/media-core/mime";

export function buildAssistantMediaContentDisposition(filename: string, mime?: string): string {
  // Keep the RFC 6266 fallback ASCII; filename* carries the exact UTF-8 name.
  const sanitizedInput = truncateFilenamePreservingExtension(
    toWellFormedFilename(filename.replace(/[\r\n]/g, "_")),
    200,
  );
  const fallback = sanitizedInput.replace(/[^\x20-\x7e]|[%"\\]/g, "_").trim() || "download";
  const extended = encodeURIComponent(sanitizedInput).replace(
    /[\x27()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const kind = kindFromMime(mime);
  const inline = kind === "image" || kind === "audio" || kind === "video";
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${extended}`;
}

function toWellFormedFilename(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    result += char.length === 1 && code >= 0xd800 && code <= 0xdfff ? "\uFFFD" : char;
  }
  return result;
}

function truncateFilenamePreservingExtension(value: string, maxCodePoints: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxCodePoints) {
    return value;
  }
  const extension = shortFilenameExtension(chars);
  if (extension.length === 0 || extension.length >= maxCodePoints - 1) {
    return chars.slice(0, maxCodePoints).join("");
  }
  return `${chars.slice(0, maxCodePoints - extension.length).join("")}${extension.join("")}`;
}

function shortFilenameExtension(chars: string[]): string[] {
  const lastDot = chars.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === chars.length - 1) {
    return [];
  }
  const extension = chars.slice(lastDot);
  // Preserve normal save-dialog type hints without letting an oversized suffix
  // consume the whole bounded filename.
  return extension.length <= 32 ? extension : [];
}
