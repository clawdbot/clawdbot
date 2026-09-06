import type { HtmlTagToken } from "./html-tags.js";

export const RAW_HTML_TOKEN_TYPE = "markdown_core_html";

export type MarkdownHtmlMetadata = {
  /** Complete authored HTML tags in UTF-16 offsets; omitted from serialized IR. */
  htmlTags?: HtmlTagToken[];
};

export function defineMetadata<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K],
): void;
export function defineMetadata(
  target: object,
  key: "htmlTags",
  value: HtmlTagToken[] | undefined,
): void;
export function defineMetadata(target: object, key: PropertyKey, value: unknown): void {
  if (value !== undefined) {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: false,
      value,
      writable: true,
    });
  }
}

function htmlTags(source: object | undefined): HtmlTagToken[] | undefined {
  // SAFETY: This owner writes the metadata; upstream Token lacks the declared IR field.
  return (source as MarkdownHtmlMetadata | undefined)?.htmlTags;
}

/** A fragment cannot inherit a whole tag's meaning; spreads omit these parser-owned facts. */
export function copyHtmlTags<T extends object>(
  source: object,
  target: T,
  start = 0,
  end = Number.POSITIVE_INFINITY,
): T {
  const tags: HtmlTagToken[] = [];
  for (const tag of htmlTags(source) ?? []) {
    if (tag.start >= start && tag.end <= end) {
      tags.push({ ...tag, start: tag.start - start, end: tag.end - start });
    }
  }
  if (tags.length) {
    defineMetadata(target, "htmlTags", tags);
  }
  return target;
}

/** Keep separate tag facts and fresh offsets so appending cannot mutate the source. */
export function appendHtmlTags(target: object, source: object | undefined, offset: number): void {
  const incoming = htmlTags(source);
  if (!incoming?.length) {
    return;
  }
  const tags = htmlTags(target) ?? [];
  for (const tag of incoming) {
    tags.push({ ...tag, start: offset + tag.start, end: offset + tag.end });
  }
  defineMetadata(target, "htmlTags", tags);
}
