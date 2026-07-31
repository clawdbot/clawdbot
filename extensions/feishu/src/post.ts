// Feishu plugin module implements post behavior.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isRecord } from "./comment-shared.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { extractMarkdownImageKeys, extractMarkdownMentionIds } from "./post-image-inline.js";

const FALLBACK_POST_TEXT = "[Rich text message]";
const MARKDOWN_SPECIAL_CHARS = /([\\`*_{}[\]()#+\-!|>~])/g;

type PostParseResult = {
  textContent: string;
  imageKeys: string[];
  mediaKeys: Array<{ fileKey: string; fileName?: string }>;
  mentionedOpenIds: string[];
};

type PostPayload = {
  title: string;
  content: unknown[];
  contentV2?: unknown[];
};

function toStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function escapeMarkdownText(text: string): string {
  return text.replace(MARKDOWN_SPECIAL_CHARS, "\\$1");
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "true";
}

function isStyleEnabled(style: Record<string, unknown> | undefined, key: string): boolean {
  if (!style) {
    return false;
  }
  return toBoolean(style[key]);
}

function wrapInlineCode(text: string): string {
  const maxRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(maxRun + 1);
  const needsPadding = text.startsWith("`") || text.endsWith("`");
  const body = needsPadding ? ` ${text} ` : text;
  return `${fence}${body}${fence}`;
}

function sanitizeFenceLanguage(language: string): string {
  return language.trim().replace(/[^A-Za-z0-9_+#.-]/g, "");
}

function renderTextElement(element: Record<string, unknown>): string {
  const text = toStringOrEmpty(element.text);
  const style = isRecord(element.style) ? element.style : undefined;

  if (isStyleEnabled(style, "code")) {
    return wrapInlineCode(text);
  }

  let rendered = escapeMarkdownText(text);
  if (!rendered) {
    return "";
  }

  if (isStyleEnabled(style, "bold")) {
    rendered = `**${rendered}**`;
  }
  if (isStyleEnabled(style, "italic")) {
    rendered = `*${rendered}*`;
  }
  if (isStyleEnabled(style, "underline")) {
    rendered = `<u>${rendered}</u>`;
  }
  if (
    isStyleEnabled(style, "strikethrough") ||
    isStyleEnabled(style, "line_through") ||
    isStyleEnabled(style, "lineThrough")
  ) {
    rendered = `~~${rendered}~~`;
  }
  return rendered;
}

function renderLinkElement(element: Record<string, unknown>): string {
  const href = toStringOrEmpty(element.href).trim();
  const rawText = toStringOrEmpty(element.text);
  const text = rawText || href;
  if (!text) {
    return "";
  }
  if (!href) {
    return escapeMarkdownText(text);
  }
  return `[${escapeMarkdownText(text)}](${href})`;
}

function renderMentionElement(element: Record<string, unknown>): string {
  const mention =
    toStringOrEmpty(element.user_name) ||
    toStringOrEmpty(element.user_id) ||
    toStringOrEmpty(element.open_id);
  if (!mention) {
    return "";
  }
  return `@${escapeMarkdownText(mention)}`;
}

function renderEmotionElement(element: Record<string, unknown>): string {
  const text =
    toStringOrEmpty(element.emoji) ||
    toStringOrEmpty(element.text) ||
    toStringOrEmpty(element.emoji_type);
  return escapeMarkdownText(text);
}

function renderCodeBlockElement(element: Record<string, unknown>): string {
  const language = sanitizeFenceLanguage(
    toStringOrEmpty(element.language) || toStringOrEmpty(element.lang),
  );
  const code = (toStringOrEmpty(element.text) || toStringOrEmpty(element.content)).replace(
    /\r\n/g,
    "\n",
  );
  const trailingNewline = code.endsWith("\n") ? "" : "\n";
  return `\`\`\`${language}\n${code}${trailingNewline}\`\`\``;
}

function renderElement(
  element: unknown,
  imageKeys: string[],
  mediaKeys: Array<{ fileKey: string; fileName?: string }>,
  mentionedOpenIds: string[],
  renderMediaPlaceholders: boolean,
): string {
  if (!isRecord(element)) {
    return escapeMarkdownText(toStringOrEmpty(element));
  }

  const tag = normalizeLowercaseStringOrEmpty(toStringOrEmpty(element.tag));
  switch (tag) {
    case "text":
      return renderTextElement(element);
    case "a":
      return renderLinkElement(element);
    case "at":
      {
        const mentioned = toStringOrEmpty(element.open_id) || toStringOrEmpty(element.user_id);
        const normalizedMention = normalizeFeishuExternalKey(mentioned);
        if (normalizedMention) {
          mentionedOpenIds.push(normalizedMention);
        }
      }
      return renderMentionElement(element);
    case "img": {
      const imageKey = normalizeFeishuExternalKey(toStringOrEmpty(element.image_key));
      if (imageKey) {
        imageKeys.push(imageKey);
      }
      return renderMediaPlaceholders ? "![image]" : "";
    }
    case "media": {
      const fileKey = normalizeFeishuExternalKey(toStringOrEmpty(element.file_key));
      if (fileKey) {
        const fileName = toStringOrEmpty(element.file_name) || undefined;
        mediaKeys.push({ fileKey, fileName });
      }
      return renderMediaPlaceholders ? "[media]" : "";
    }
    case "emotion":
      return renderEmotionElement(element);
    case "md":
    case "lark_md":
      return toStringOrEmpty(element.text) || toStringOrEmpty(element.content);
    case "br":
      return "\n";
    case "hr":
      return "\n\n---\n\n";
    case "code": {
      const code = toStringOrEmpty(element.text) || toStringOrEmpty(element.content);
      return code ? wrapInlineCode(code) : "";
    }
    case "code_block":
    case "pre":
      return renderCodeBlockElement(element);
    default:
      return escapeMarkdownText(toStringOrEmpty(element.text));
  }
}

function toPostPayload(candidate: unknown): PostPayload | null {
  if (!isRecord(candidate) || !Array.isArray(candidate.content)) {
    return null;
  }
  return {
    title: toStringOrEmpty(candidate.title),
    content: candidate.content,
    // content_v2 is a sibling array carrying native markdown (tag:md). Non-array
    // shapes are treated as absent so parsePostContent falls back to content.
    contentV2: Array.isArray(candidate.content_v2) ? candidate.content_v2 : undefined,
  };
}

function resolveLocalePayload(candidate: unknown): PostPayload | null {
  const direct = toPostPayload(candidate);
  if (direct) {
    return direct;
  }
  if (!isRecord(candidate)) {
    return null;
  }
  for (const value of Object.values(candidate)) {
    const localePayload = toPostPayload(value);
    if (localePayload) {
      return localePayload;
    }
  }
  return null;
}

function resolvePostPayload(parsed: unknown): PostPayload | null {
  const direct = toPostPayload(parsed);
  if (direct) {
    return direct;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const wrappedPost = resolveLocalePayload(parsed.post);
  if (wrappedPost) {
    return wrappedPost;
  }

  return resolveLocalePayload(parsed);
}

type RenderedPostBody = {
  body: string;
  imageKeys: string[];
  mediaKeys: Array<{ fileKey: string; fileName?: string }>;
  mentionedOpenIds: string[];
};

type RenderPostParagraphOptions = {
  useV2: boolean;
  renderMediaPlaceholders: boolean;
};

function renderPostParagraphs(
  source: unknown[],
  options: RenderPostParagraphOptions,
): RenderedPostBody {
  const imageKeys: string[] = [];
  const mediaKeys: Array<{ fileKey: string; fileName?: string }> = [];
  const mentionedOpenIds: string[] = [];
  const paragraphs: string[] = [];

  for (const paragraph of source) {
    if (!Array.isArray(paragraph)) {
      continue;
    }
    let renderedParagraph = "";
    for (const element of paragraph) {
      renderedParagraph += renderElement(
        element,
        imageKeys,
        mediaKeys,
        mentionedOpenIds,
        options.renderMediaPlaceholders,
      );
      // content_v2 md elements keep native image and mention extensions inline.
      // Scan both outside code regions; content-path tags are already handled above.
      if (options.useV2 && isRecord(element)) {
        const tag = normalizeLowercaseStringOrEmpty(toStringOrEmpty(element.tag));
        if (tag === "md" || tag === "lark_md") {
          const mdText = toStringOrEmpty(element.text) || toStringOrEmpty(element.content);
          imageKeys.push(...extractMarkdownImageKeys(mdText));
          mentionedOpenIds.push(...extractMarkdownMentionIds(mdText));
        }
      }
    }
    paragraphs.push(renderedParagraph);
  }

  return { body: paragraphs.join("\n").trim(), imageKeys, mediaKeys, mentionedOpenIds };
}

/** A render with no body text and no media carries nothing usable for the agent. */
function isUnusablePostBody(rendered: RenderedPostBody): boolean {
  return rendered.body === "" && rendered.imageKeys.length === 0 && rendered.mediaKeys.length === 0;
}

export function parsePostContent(
  content: string,
  options: { renderMediaPlaceholders?: boolean; emptyTextFallback?: string } = {},
): PostParseResult {
  try {
    const parsed = JSON.parse(content);
    const payload = resolvePostPayload(parsed);
    if (!payload) {
      return {
        textContent: FALLBACK_POST_TEXT,
        imageKeys: [],
        mediaKeys: [],
        mentionedOpenIds: [],
      };
    }

    // Prefer the parallel content_v2 (native markdown) when present; an absent or
    // empty content_v2 falls back to content with byte-identical behavior.
    const hasV2 = Array.isArray(payload.contentV2) && payload.contentV2.length > 0;
    const renderMediaPlaceholders = options.renderMediaPlaceholders !== false;
    let rendered = renderPostParagraphs(
      hasV2 ? (payload.contentV2 as unknown[]) : payload.content,
      {
        useV2: hasV2,
        renderMediaPlaceholders,
      },
    );
    // content_v2 can be a non-empty array that still renders no usable text/media
    // (e.g. only unknown tags); fall back to content so the agent isn't fed an empty body.
    if (hasV2 && isUnusablePostBody(rendered)) {
      rendered = renderPostParagraphs(payload.content, {
        useV2: false,
        renderMediaPlaceholders,
      });
    }

    const title = escapeMarkdownText(payload.title.trim());
    const textContent = [title, rendered.body].filter(Boolean).join("\n\n").trim();

    return {
      textContent: textContent || (options.emptyTextFallback ?? FALLBACK_POST_TEXT),
      // One image referenced twice (common in content_v2 markdown) is one download
      // and one dedupe-key part; order-preserving dedup keeps content/content_v2 key
      // sets identical so the message dedupe key stays stable.
      imageKeys: [...new Set(rendered.imageKeys)],
      mediaKeys: rendered.mediaKeys,
      mentionedOpenIds: rendered.mentionedOpenIds,
    };
  } catch {
    return { textContent: FALLBACK_POST_TEXT, imageKeys: [], mediaKeys: [], mentionedOpenIds: [] };
  }
}
