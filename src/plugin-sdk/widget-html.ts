const COMPLETE_HTML_DOCUMENT_PATTERN = /^(?:<!doctype\s+html\b|<html\b)/i;

/** Input error surfaced by tools that accept agent-supplied widget HTML. */
export class WidgetHtmlInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** Returns true when HTML already contains its own document shell. */
export function isCompleteHtmlDocument(html: string): boolean {
  return COMPLETE_HTML_DOCUMENT_PATTERN.test(html.trimStart());
}

/** Enforces a widget HTML size limit while preserving the caller's input label and unit. */
export function assertWidgetHtmlSize(
  html: string,
  maxSize: number,
  options: {
    inputName?: string;
    unit?: "bytes" | "characters";
  } = {},
): void {
  const inputName = options.inputName ?? "html";
  const unit = options.unit ?? "bytes";
  const size = unit === "bytes" ? new TextEncoder().encode(html).byteLength : html.length;
  if (size > maxSize) {
    throw new WidgetHtmlInputError(`${inputName} exceeds maximum size (${maxSize} ${unit})`);
  }
}
