// Slack helper module supports format behavior.
import { eastAsianWidthType } from "get-east-asian-width";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import {
  chunkTextForOutbound,
  FormatCapabilityProfile,
  markdownToIR,
  type MarkdownIR,
  type MarkdownLinkSpan,
  renderMarkdownIRChunksWithinLimit,
  renderMarkdownWithMarkers,
} from "openclaw/plugin-sdk/text-chunking";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";

const SLACK_ANGLE_TOKEN_RE = /<[^>\n]+>/g;

function isAllowedSlackAngleToken(token: string): boolean {
  if (!token.startsWith("<") || !token.endsWith(">")) {
    return false;
  }
  const inner = token.slice(1, -1);
  return (
    inner.startsWith("@") ||
    inner.startsWith("#") ||
    inner.startsWith("!") ||
    inner.startsWith("mailto:") ||
    inner.startsWith("tel:") ||
    inner.startsWith("http://") ||
    inner.startsWith("https://") ||
    inner.startsWith("slack://")
  );
}

function escapeSlackMrkdwnContent(text: string, mentions?: "escape"): string {
  if (mentions === "escape") {
    return escapeSlackMrkdwn(text);
  }
  if (!text) {
    return "";
  }
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
    return text;
  }

  SLACK_ANGLE_TOKEN_RE.lastIndex = 0;
  const out: string[] = [];
  let lastIndex = 0;

  for (
    let match = SLACK_ANGLE_TOKEN_RE.exec(text);
    match;
    match = SLACK_ANGLE_TOKEN_RE.exec(text)
  ) {
    const matchIndex = match.index ?? 0;
    out.push(escapeSlackMrkdwn(text.slice(lastIndex, matchIndex)));
    const token = match[0] ?? "";
    out.push(isAllowedSlackAngleToken(token) ? token : escapeSlackMrkdwn(token));
    lastIndex = matchIndex + token.length;
  }

  out.push(escapeSlackMrkdwn(text.slice(lastIndex)));
  return out.join("");
}

function escapeSlackMrkdwnText(text: string, mentions?: "escape"): string {
  if (!text) {
    return "";
  }
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
    return text;
  }

  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("> ")) {
        return `> ${escapeSlackMrkdwnContent(line.slice(2), mentions)}`;
      }
      return escapeSlackMrkdwnContent(line, mentions);
    })
    .join("\n");
}

function buildSlackLink(link: MarkdownLinkSpan, text: string) {
  const href = link.href.trim();
  if (!href) {
    return null;
  }
  const label = text.slice(link.start, link.end);
  const trimmedLabel = label.trim();
  const comparableHref = href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
  const useMarkup =
    trimmedLabel.length > 0 && trimmedLabel !== href && trimmedLabel !== comparableHref;
  if (!useMarkup) {
    return null;
  }
  const safeHref = escapeSlackMrkdwn(href);
  return {
    start: link.start,
    end: link.end,
    open: `<${safeHref}|`,
    close: ">",
  };
}

type SlackMarkdownOptions = {
  tableMode?: MarkdownTableMode;
  /** The caller wraps the output in this emphasis; Slack cannot nest the same style, so inner markers are dropped. */
  enclosingStyle?: "bold" | "italic";
  /** Escape every Slack angle token (mentions, special commands, links) instead of preserving it. */
  mentions?: "escape";
};

const SLACK_MRKDWN_WORD_CHARACTER_RE = /[\p{L}\p{M}\p{N}_]/u;
const SLACK_MRKDWN_PUNCTUATION_RE = /\p{P}/u;
const SLACK_MRKDWN_SYMBOL_RE = /\p{S}/u;
const SLACK_MRKDWN_CJK_SCRIPT_RE =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]/u;
const SLACK_MRKDWN_EMOJI_PRESENTATION_RE = /\p{Emoji_Presentation}/u;

function getCodePointBefore(text: string, index: number): string {
  if (index <= 0) {
    return "";
  }
  const lastCodeUnit = text.charCodeAt(index - 1);
  if (lastCodeUnit >= 0xdc00 && lastCodeUnit <= 0xdfff && index > 1) {
    const previousCodeUnit = text.charCodeAt(index - 2);
    if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff) {
      return text.slice(index - 2, index);
    }
  }
  return text[index - 1] ?? "";
}

function getCodePointAt(text: string, index: number): string {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

function isSlackCjkPunctuation(character: string): boolean {
  if (!SLACK_MRKDWN_PUNCTUATION_RE.test(character)) {
    return false;
  }
  if (SLACK_MRKDWN_CJK_SCRIPT_RE.test(character)) {
    return true;
  }
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    return false;
  }
  const width = eastAsianWidthType(codePoint);
  return (
    width === "fullwidth" ||
    width === "halfwidth" ||
    (width === "wide" && !SLACK_MRKDWN_EMOJI_PRESENTATION_RE.test(character))
  );
}

function isUnsafeSlackEmphasisBoundary(character: string): boolean {
  if (SLACK_MRKDWN_WORD_CHARACTER_RE.test(character)) {
    return true;
  }
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined || codePoint <= 0x7f) {
    return false;
  }
  return SLACK_MRKDWN_SYMBOL_RE.test(character) || isSlackCjkPunctuation(character);
}

function makeSlackEmphasisStylesSafe(ir: MarkdownIR): MarkdownIR {
  const styles = ir.styles.filter((span) => {
    if (span.style !== "italic" && span.style !== "bold") {
      return true;
    }
    // Slack's parser can expose markers accepted by the CJK-friendly Markdown parser.
    // Drop only the affected style so transport syntax never leaks into visible text.
    return (
      !isUnsafeSlackEmphasisBoundary(getCodePointBefore(ir.text, span.start)) &&
      !isUnsafeSlackEmphasisBoundary(getCodePointAt(ir.text, span.end))
    );
  });
  return styles.length === ir.styles.length ? ir : { ...ir, styles };
}

const SLACK_FORMAT_PROFILE = FormatCapabilityProfile.define({
  mechanism: "markdown",
  constructs: {
    underline: "strip",
    spoiler: "fallback",
    codeLanguage: "fallback",
    heading: "fallback",
    bulletList: "fallback",
    orderedList: "fallback",
    taskList: "fallback",
    table: "fallback",
    image: "fallback",
  },
  chunk: { limit: 4000, unit: "chars", hardCap: 40_000 },
});

type SlackCodeMarker = "`" | "```";
const SLACK_ASSISTANT_TRANSCRIPT_PREFIX = "`Assistant:` ";

function tokenizeSlackMrkdwn(text: string): string[] {
  const tokens: string[] = [];
  for (let index = 0; index < text.length;) {
    if (text.startsWith("```", index)) {
      tokens.push("```");
      index += 3;
      continue;
    }
    const entity = ["&amp;", "&lt;", "&gt;"].find((candidate) => text.startsWith(candidate, index));
    if (entity) {
      tokens.push(entity);
      index += entity.length;
      continue;
    }
    if (text[index] === "<") {
      const end = text.indexOf(">", index + 1);
      const angleToken = end >= 0 ? text.slice(index, end + 1) : undefined;
      if (angleToken && !angleToken.includes("\n") && isAllowedSlackAngleToken(angleToken)) {
        tokens.push(angleToken);
        index += angleToken.length;
        continue;
      }
    }
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const character = String.fromCodePoint(codePoint);
    index += character.length;
    if (character === "\\" && index < text.length) {
      const escapedCodePoint = text.codePointAt(index);
      if (escapedCodePoint !== undefined) {
        const escapedCharacter = String.fromCodePoint(escapedCodePoint);
        tokens.push(character + escapedCharacter);
        index += escapedCharacter.length;
        continue;
      }
    }
    tokens.push(character);
  }
  return tokens;
}

function resolveSlackCodeMarkerTransition(
  active: SlackCodeMarker | undefined,
  token: string,
): SlackCodeMarker | undefined | null {
  if (token === "```" && active !== "`") {
    return active === "```" ? undefined : "```";
  }
  if (token === "`" && active !== "```") {
    return active === "`" ? undefined : "`";
  }
  return null;
}

type SlackVisibleProjection = {
  text: string;
  excludedRanges: Array<{ start: number; end: number }>;
};

function maskSlackExcludedText(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line.trim() ? `x${" ".repeat(Math.max(0, line.length - 1))}` : " ".repeat(line.length),
    )
    .join("\n");
}

function maskSlackExcludedRanges(projection: SlackVisibleProjection): string {
  let masked = "";
  let cursor = 0;
  for (const range of projection.excludedRanges) {
    masked += projection.text.slice(cursor, range.start);
    masked += maskSlackExcludedText(projection.text.slice(range.start, range.end));
    cursor = range.end;
  }
  return masked + projection.text.slice(cursor);
}

function slackProjectionHasRoleHeader(projection: SlackVisibleProjection): boolean {
  return Boolean(
    markdownToIR(maskSlackExcludedRanges(projection), {
      assistantTranscriptRoleHeaders: true,
      autolink: false,
      blockquotePrefix: "",
      headingStyle: "none",
      linkify: false,
      tableMode: "off",
    }).annotations?.some((annotation) => annotation.type === "assistant_transcript_role"),
  );
}

function decodeSlackMrkdwnEntities(text: string): string {
  return text.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

type SlackDateDisplay = "fallback" | "token";

function projectSlackAngleToken(token: string, dateDisplay: SlackDateDisplay): string {
  const inner = token.slice(1, -1);
  if (inner.startsWith("!date^")) {
    const fallbackSeparator = inner.indexOf("|");
    const dateControl = fallbackSeparator === -1 ? inner : inner.slice(0, fallbackSeparator);
    const tokenString = dateControl.split("^")[2] ?? "";
    const fallback = fallbackSeparator === -1 ? "" : inner.slice(fallbackSeparator + 1);
    // Modern clients render tokenString; older clients render fallback.
    return decodeSlackMrkdwnEntities(
      dateDisplay === "fallback" ? fallback || tokenString : tokenString || fallback,
    );
  }
  const labelSeparator = inner.indexOf("|");
  if (labelSeparator >= 0) {
    return decodeSlackMrkdwnEntities(inner.slice(labelSeparator + 1));
  }
  if (inner.startsWith("@")) {
    return "@";
  }
  if (inner.startsWith("#")) {
    return "#";
  }
  if (inner.startsWith("!")) {
    return "!";
  }
  return decodeSlackMrkdwnEntities(inner);
}

function appendSlackVisibleProjection(
  projection: SlackVisibleProjection,
  visible: string,
  excluded: boolean,
): void {
  if (!visible) {
    return;
  }
  const start = projection.text.length;
  projection.text += visible;
  if (!excluded) {
    return;
  }
  const previous = projection.excludedRanges.at(-1);
  if (previous?.end === start) {
    previous.end = projection.text.length;
  } else {
    projection.excludedRanges.push({ start, end: projection.text.length });
  }
}

function projectSlackMrkdwnVisibleText(
  text: string,
  dateDisplay: SlackDateDisplay,
): SlackVisibleProjection {
  const projection: SlackVisibleProjection = { text: "", excludedRanges: [] };
  let activeMarker: SlackCodeMarker | undefined;
  let lineHasVisibleContent = false;

  for (const token of tokenizeSlackMrkdwn(text)) {
    const transition = resolveSlackCodeMarkerTransition(activeMarker, token);
    if (transition !== null) {
      activeMarker = transition;
      continue;
    }

    let visible = token;
    if (isAllowedSlackAngleToken(token)) {
      visible = activeMarker ? token : projectSlackAngleToken(token, dateDisplay);
    } else if (token === "&amp;" || token === "&lt;" || token === "&gt;") {
      visible = decodeSlackMrkdwnEntities(token);
    } else if (!activeMarker && (token === "*" || token === "_" || token === "~")) {
      visible = "";
    } else if (!activeMarker && token === ">" && !lineHasVisibleContent) {
      visible = "";
    } else if (token.startsWith("\\") && token.length > 1) {
      visible = token.slice(1);
    }

    appendSlackVisibleProjection(projection, visible, activeMarker !== undefined);
    for (const character of visible) {
      if (character === "\n") {
        lineHasVisibleContent = false;
      } else if (character !== " " && character !== "\t" && character !== "\r") {
        lineHasVisibleContent = true;
      }
    }
  }
  return projection;
}

function protectSlackAssistantTranscriptRoleHeaders(text: string): string {
  if (text.startsWith(SLACK_ASSISTANT_TRANSCRIPT_PREFIX)) {
    return text;
  }
  const tokenProjection = projectSlackMrkdwnVisibleText(text, "token");
  // Only native date tokens have different modern-client and fallback text.
  if (
    !slackProjectionHasRoleHeader(tokenProjection) &&
    (!text.includes("<!date^") ||
      !slackProjectionHasRoleHeader(projectSlackMrkdwnVisibleText(text, "fallback")))
  ) {
    return text;
  }
  // Target-native mrkdwn can reveal a header only after the Markdown parser ran.
  return `${SLACK_ASSISTANT_TRANSCRIPT_PREFIX}${text}`;
}

function buildSlackRenderOptions({ enclosingStyle, mentions }: SlackMarkdownOptions = {}) {
  return {
    annotationMarkers: {
      assistant_transcript_role: {
        open: "`",
        close: "`",
        suppressNestedFormatting: true,
      },
    },
    styleMarkers: {
      // Slack cannot nest the same emphasis style inside a caller-provided wrapper.
      ...(enclosingStyle !== "bold" ? { bold: { open: "*", close: "*" } } : {}),
      ...(enclosingStyle !== "italic" ? { italic: { open: "_", close: "_" } } : {}),
      strikethrough: { open: "~", close: "~" },
      code: { open: "`", close: "`" },
      code_block: { open: "```\n", close: "```" },
    },
    escapeText: (text: string) => escapeSlackMrkdwnText(text, mentions),
    buildLink: buildSlackLink,
  };
}

export function normalizeSlackOutboundText(
  markdown: string,
  options: SlackMarkdownOptions = {},
): string {
  const ir = makeSlackEmphasisStylesSafe(
    markdownToIR(markdown ?? "", {
      assistantTranscriptRoleHeaders: true,
      linkify: false,
      autolink: false,
      headingStyle: "rich",
      blockquotePrefix: "> ",
      tableMode: options.tableMode,
    }),
  );
  return protectSlackAssistantTranscriptRoleHeaders(
    renderMarkdownWithMarkers(ir, buildSlackRenderOptions(options), SLACK_FORMAT_PROFILE),
  );
}

/** Chunk already-rendered Slack mrkdwn without splitting entities or code markers. */
export function chunkSlackMrkdwnText(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }
  const hasProtectedToken =
    text.includes("`") ||
    text.includes("&amp;") ||
    text.includes("&lt;") ||
    text.includes("&gt;") ||
    (text.match(/<[^>\n]+>/gu)?.some(isAllowedSlackAngleToken) ?? false) ||
    /\\[\s\S]/u.test(text);
  if (!hasProtectedToken) {
    return chunkTextForOutbound(text, limit, { preserveWhitespace: true });
  }

  const chunks: string[] = [];
  let activeMarker: SlackCodeMarker | undefined;
  let content = "";
  const wrapper = (marker: SlackCodeMarker | undefined) =>
    marker && limit > marker.length * 2 ? marker : undefined;
  const capacity = (marker: SlackCodeMarker | undefined) => limit - (wrapper(marker)?.length ?? 0);
  const flush = () => {
    const marker = wrapper(activeMarker);
    if (content && content !== marker) {
      chunks.push(marker ? `${content}${marker}` : content);
    }
    content = "";
  };

  for (const token of tokenizeSlackMrkdwn(text)) {
    const transition = resolveSlackCodeMarkerTransition(activeMarker, token);
    const nextMarker = transition === null ? activeMarker : transition;
    const sourceMarker = token === "`" || token === "```" ? token : undefined;
    if (transition !== null && sourceMarker && !wrapper(sourceMarker)) {
      activeMarker = nextMarker;
      continue;
    }
    if (content && content.length + token.length > capacity(nextMarker)) {
      flush();
    }
    activeMarker = nextMarker;
    if (!content && transition === undefined) {
      continue;
    }
    content ||= transition === null ? (wrapper(activeMarker) ?? "") : "";

    const contentLimit = capacity(activeMarker) - (wrapper(activeMarker)?.length ?? 0);
    if (token.length > contentLimit) {
      flush();
      const marker = wrapper(activeMarker);
      if (activeMarker && isAllowedSlackAngleToken(token)) {
        if (marker) {
          chunks.push(
            ...chunkTextForOutbound(token, Math.max(1, Math.floor(contentLimit)), {
              preserveWhitespace: true,
            }).map((fragment) => `${marker}${fragment}${marker}`),
          );
        } else {
          chunks.push(
            ...chunkTextForOutbound(escapeSlackMrkdwn(token), Math.max(1, Math.floor(limit)), {
              preserveWhitespace: true,
            }),
          );
        }
        continue;
      }
      chunks.push(...(token.length <= limit ? [token] : chunkTextForOutbound(token, limit)));
      continue;
    }
    content += token;
  }
  flush();
  return chunks;
}

export function markdownToSlackMrkdwnChunks(
  markdown: string,
  limit: number,
  options: SlackMarkdownOptions = {},
): string[] {
  const ir = makeSlackEmphasisStylesSafe(
    markdownToIR(markdown ?? "", {
      assistantTranscriptRoleHeaders: true,
      linkify: false,
      autolink: false,
      headingStyle: "rich",
      blockquotePrefix: "> ",
      tableMode: options.tableMode,
    }),
  );
  const renderOptions = buildSlackRenderOptions();
  return renderMarkdownIRChunksWithinLimit({
    ir,
    limit,
    renderChunk: (chunk) =>
      protectSlackAssistantTranscriptRoleHeaders(
        renderMarkdownWithMarkers(chunk, renderOptions, SLACK_FORMAT_PROFILE),
      ),
    measureRendered: (rendered) => rendered.length,
  }).map(({ rendered }) => rendered);
}
