// Slack helper module supports format behavior.
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import {
  chunkTextForOutbound,
  markdownToIR,
  type MarkdownLinkSpan,
  renderMarkdownIRChunksWithinLimit,
} from "openclaw/plugin-sdk/text-chunking";
import { renderMarkdownWithMarkers } from "openclaw/plugin-sdk/text-chunking";

// Escape special characters for Slack mrkdwn format.
// Preserve Slack's angle-bracket tokens so mentions and links stay intact.
function escapeSlackMrkdwnSegment(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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

function escapeSlackMrkdwnContent(text: string): string {
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
    out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex, matchIndex)));
    const token = match[0] ?? "";
    out.push(isAllowedSlackAngleToken(token) ? token : escapeSlackMrkdwnSegment(token));
    lastIndex = matchIndex + token.length;
  }

  out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex)));
  return out.join("");
}

function escapeSlackMrkdwnText(text: string): string {
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
        return `> ${escapeSlackMrkdwnContent(line.slice(2))}`;
      }
      return escapeSlackMrkdwnContent(line);
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
  const safeHref = escapeSlackMrkdwnSegment(href);
  return {
    start: link.start,
    end: link.end,
    open: `<${safeHref}|`,
    close: ">",
  };
}

type SlackMarkdownOptions = {
  tableMode?: MarkdownTableMode;
};

type SlackCodeMarker = "`" | "```";

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

function hardSliceSlackToken(token: string, limit: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of token) {
    if (chunk && chunk.length + character.length > limit) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) {
    chunks.push(chunk);
  }
  return chunks;
}

function buildSlackRenderOptions() {
  return {
    styleMarkers: {
      bold: { open: "*", close: "*" },
      italic: { open: "_", close: "_" },
      strikethrough: { open: "~", close: "~" },
      code: { open: "`", close: "`" },
      code_block: { open: "```\n", close: "```" },
    },
    escapeText: escapeSlackMrkdwnText,
    buildLink: buildSlackLink,
  };
}

export function markdownToSlackMrkdwn(
  markdown: string,
  options: SlackMarkdownOptions = {},
): string {
  const ir = markdownToIR(markdown ?? "", {
    linkify: false,
    autolink: false,
    headingStyle: "bold",
    blockquotePrefix: "> ",
    tableMode: options.tableMode,
  });
  return renderMarkdownWithMarkers(ir, buildSlackRenderOptions());
}

export function normalizeSlackOutboundText(markdown: string): string {
  return markdownToSlackMrkdwn(markdown ?? "");
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
    return chunkTextForOutbound(text, limit);
  }

  const chunks: string[] = [];
  let activeMarker: SlackCodeMarker | undefined;
  let content = "";
  const wrapper = () =>
    activeMarker && limit > activeMarker.length * 2 ? activeMarker : undefined;
  const capacity = () => limit - (wrapper()?.length ?? 0) * 2;
  const flush = () => {
    if (!content) {
      return;
    }
    const marker = wrapper();
    chunks.push(marker ? `${marker}${content}${marker}` : content);
    content = "";
  };

  for (const token of tokenizeSlackMrkdwn(text)) {
    const transition = resolveSlackCodeMarkerTransition(activeMarker, token);
    if (transition !== null) {
      flush();
      activeMarker = transition;
      continue;
    }

    const contentLimit = capacity();
    if (token.length > contentLimit) {
      flush();
      const marker = wrapper();
      if (activeMarker && isAllowedSlackAngleToken(token)) {
        if (marker) {
          chunks.push(
            ...hardSliceSlackToken(token, contentLimit).map(
              (fragment) => `${marker}${fragment}${marker}`,
            ),
          );
        } else {
          chunks.push(...hardSliceSlackToken(escapeSlackMrkdwnSegment(token), limit));
        }
        continue;
      }
      chunks.push(...(token.length <= limit ? [token] : chunkTextForOutbound(token, limit)));
      continue;
    }
    if (content && content.length + token.length > contentLimit) {
      flush();
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
  const ir = markdownToIR(markdown ?? "", {
    linkify: false,
    autolink: false,
    headingStyle: "bold",
    blockquotePrefix: "> ",
    tableMode: options.tableMode,
  });
  const renderOptions = buildSlackRenderOptions();
  return renderMarkdownIRChunksWithinLimit({
    ir,
    limit,
    renderChunk: (chunk) => renderMarkdownWithMarkers(chunk, renderOptions),
    measureRendered: (rendered) => rendered.length,
  }).map(({ rendered }) => rendered);
}
