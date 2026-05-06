import { sanitizeUntrustedFileName } from "../infra/fs-safe-advanced.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

const XML_ESCAPE_MAP: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  '"': "&quot;",
  "'": "&apos;",
};

function xmlEscapeAttr(value: string): string {
  return value.replace(/[<>&"']/g, (char) => XML_ESCAPE_MAP[char] ?? char);
}

function escapeFileBlockContent(value: string): string {
  return value.replace(/<\s*\/\s*file\s*>/gi, "&lt;/file&gt;").replace(/<\s*file\b/gi, "&lt;file");
}

function sanitizeFileName(value: string | null | undefined, fallbackName: string): string {
  const normalized =
    normalizeOptionalString(
      typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ") : undefined,
    ) ?? "";
  return sanitizeUntrustedFileName(normalized, fallbackName);
}

export function renderFileContextBlock(params: {
  filename?: string | null;
  fallbackName?: string;
  mimeType?: string | null;
  content: string;
  surroundContentWithNewlines?: boolean;
}): string {
  const fallbackName = normalizeOptionalString(params.fallbackName) ?? "attachment";
  const safeName = sanitizeFileName(params.filename, fallbackName);
  const safeContent = escapeFileBlockContent(params.content);
  const mimeType = normalizeOptionalString(params.mimeType);
  const attrs = [
    `name="${xmlEscapeAttr(safeName)}"`,
    mimeType ? `mime="${xmlEscapeAttr(mimeType)}"` : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  if (params.surroundContentWithNewlines === false) {
    return `<file ${attrs}>${safeContent}</file>`;
  }
  return `<file ${attrs}>\n${safeContent}\n</file>`;
}
