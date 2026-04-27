import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { isRecord } from "./comment-shared.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";

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
      return "![image]";
    }
    case "media": {
      const fileKey = normalizeFeishuExternalKey(toStringOrEmpty(element.file_key));
      if (fileKey) {
        const fileName = toStringOrEmpty(element.file_name) || undefined;
        mediaKeys.push({ fileKey, fileName });
      }
      return "[media]";
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

export function parsePostContent(content: string): PostParseResult {
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

    const imageKeys: string[] = [];
    const mediaKeys: Array<{ fileKey: string; fileName?: string }> = [];
    const mentionedOpenIds: string[] = [];
    const paragraphs: string[] = [];

    for (const paragraph of payload.content) {
      if (!Array.isArray(paragraph)) {
        continue;
      }
      let renderedParagraph = "";
      for (const element of paragraph) {
        renderedParagraph += renderElement(element, imageKeys, mediaKeys, mentionedOpenIds);
      }
      paragraphs.push(renderedParagraph);
    }

    const title = escapeMarkdownText(payload.title.trim());
    const body = paragraphs.join("\n").trim();
    const textContent = [title, body].filter(Boolean).join("\n\n").trim();

    return {
      textContent: textContent || FALLBACK_POST_TEXT,
      imageKeys,
      mediaKeys,
      mentionedOpenIds,
    };
  } catch {
    return { textContent: FALLBACK_POST_TEXT, imageKeys: [], mediaKeys: [], mentionedOpenIds: [] };
  }
}
