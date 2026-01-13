import MarkdownIt from "markdown-it";

import { chunkText } from "../auto-reply/chunk.js";

type ListState = {
  type: "bullet" | "ordered";
  index: number;
};

type LinkState = {
  href: string;
  labelStart: number;
};

type RenderEnv = {
  listStack: ListState[];
  linkStack: LinkState[];
};

type MarkdownToken = {
  type: string;
  content?: string;
  children?: MarkdownToken[];
  attrs?: [string, string][];
  attrGet?: (name: string) => string | null;
};

export type SignalTextStyle =
  | "BOLD"
  | "ITALIC"
  | "STRIKETHROUGH"
  | "MONOSPACE"
  | "SPOILER";

export type SignalTextStyleRange = {
  start: number;
  length: number;
  style: SignalTextStyle;
};

export type SignalFormattedText = {
  text: string;
  styles: SignalTextStyleRange[];
};

type OpenStyle = {
  style: SignalTextStyle;
  start: number;
};

type RenderState = {
  text: string;
  styles: SignalTextStyleRange[];
  openStyles: OpenStyle[];
  env: RenderEnv;
};

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
});

md.enable("strikethrough");

function getAttr(token: MarkdownToken, name: string): string | null {
  if (token.attrGet) return token.attrGet(name);
  if (token.attrs) {
    for (const [key, value] of token.attrs) {
      if (key === name) return value;
    }
  }
  return null;
}

function createTextToken(base: MarkdownToken, content: string): MarkdownToken {
  return { ...base, type: "text", content, children: undefined };
}

function applySpoilerTokens(tokens: MarkdownToken[]): void {
  for (const token of tokens) {
    if (token.children && token.children.length > 0) {
      token.children = injectSpoilersIntoInline(token.children);
    }
  }
}

function injectSpoilersIntoInline(tokens: MarkdownToken[]): MarkdownToken[] {
  const result: MarkdownToken[] = [];
  const state = { spoilerOpen: false };

  for (const token of tokens) {
    if (token.type !== "text") {
      result.push(token);
      continue;
    }

    const content = token.content ?? "";
    if (!content.includes("||")) {
      result.push(token);
      continue;
    }

    let index = 0;
    while (index < content.length) {
      const next = content.indexOf("||", index);
      if (next === -1) {
        if (index < content.length) {
          result.push(createTextToken(token, content.slice(index)));
        }
        break;
      }
      if (next > index) {
        result.push(createTextToken(token, content.slice(index, next)));
      }
      state.spoilerOpen = !state.spoilerOpen;
      result.push({
        type: state.spoilerOpen ? "spoiler_open" : "spoiler_close",
      });
      index = next + 2;
    }
  }

  return result;
}

function appendText(state: RenderState, value: string) {
  if (!value) return;
  state.text += value;
}

function openStyle(state: RenderState, style: SignalTextStyle) {
  state.openStyles.push({ style, start: state.text.length });
}

function closeStyle(state: RenderState, style: SignalTextStyle) {
  for (let i = state.openStyles.length - 1; i >= 0; i -= 1) {
    if (state.openStyles[i]?.style === style) {
      const start = state.openStyles[i].start;
      state.openStyles.splice(i, 1);
      const length = state.text.length - start;
      if (length > 0) {
        state.styles.push({ start, length, style });
      }
      return;
    }
  }
}

function appendParagraphSeparator(state: RenderState) {
  if (state.env.listStack.length > 0) return;
  appendText(state, "\n\n");
}

function appendListPrefix(state: RenderState) {
  const stack = state.env.listStack;
  const top = stack[stack.length - 1];
  if (!top) return;
  top.index += 1;
  const indent = "  ".repeat(Math.max(0, stack.length - 1));
  const prefix = top.type === "ordered" ? `${top.index}. ` : "• ";
  appendText(state, `${indent}${prefix}`);
}

function renderInlineCode(state: RenderState, content: string) {
  if (!content) return;
  const start = state.text.length;
  appendText(state, content);
  state.styles.push({ start, length: content.length, style: "MONOSPACE" });
}

function renderCodeBlock(state: RenderState, content: string) {
  let code = content ?? "";
  if (!code.endsWith("\n")) code = `${code}\n`;
  const start = state.text.length;
  appendText(state, code);
  state.styles.push({ start, length: code.length, style: "MONOSPACE" });
  if (state.env.listStack.length === 0) {
    appendText(state, "\n");
  }
}

function handleLinkClose(state: RenderState) {
  const link = state.env.linkStack.pop();
  if (!link?.href) return;
  const href = link.href.trim();
  if (!href) return;

  const label = state.text.slice(link.labelStart);
  const trimmedLabel = label.trim();
  const comparableHref = href.startsWith("mailto:")
    ? href.slice("mailto:".length)
    : href;

  if (!trimmedLabel) {
    appendText(state, href);
    return;
  }
  if (trimmedLabel !== href && trimmedLabel !== comparableHref) {
    appendText(state, ` (${href})`);
  }
}

function renderTokens(tokens: MarkdownToken[], state: RenderState): void {
  for (const token of tokens) {
    switch (token.type) {
      case "inline":
        if (token.children) renderTokens(token.children, state);
        break;
      case "text":
        appendText(state, token.content ?? "");
        break;
      case "em_open":
        openStyle(state, "ITALIC");
        break;
      case "em_close":
        closeStyle(state, "ITALIC");
        break;
      case "strong_open":
        openStyle(state, "BOLD");
        break;
      case "strong_close":
        closeStyle(state, "BOLD");
        break;
      case "s_open":
        openStyle(state, "STRIKETHROUGH");
        break;
      case "s_close":
        closeStyle(state, "STRIKETHROUGH");
        break;
      case "code_inline":
        renderInlineCode(state, token.content ?? "");
        break;
      case "spoiler_open":
        openStyle(state, "SPOILER");
        break;
      case "spoiler_close":
        closeStyle(state, "SPOILER");
        break;
      case "link_open": {
        const href = getAttr(token, "href") ?? "";
        state.env.linkStack.push({ href, labelStart: state.text.length });
        break;
      }
      case "link_close":
        handleLinkClose(state);
        break;
      case "image":
        appendText(state, token.content ?? "");
        break;
      case "softbreak":
      case "hardbreak":
        appendText(state, "\n");
        break;
      case "paragraph_close":
        appendParagraphSeparator(state);
        break;
      case "heading_close":
        appendParagraphSeparator(state);
        break;
      case "blockquote_close":
        appendText(state, "\n");
        break;
      case "bullet_list_open":
        state.env.listStack.push({ type: "bullet", index: 0 });
        break;
      case "bullet_list_close":
        state.env.listStack.pop();
        break;
      case "ordered_list_open": {
        const start = Number(getAttr(token, "start") ?? "1");
        state.env.listStack.push({ type: "ordered", index: start - 1 });
        break;
      }
      case "ordered_list_close":
        state.env.listStack.pop();
        break;
      case "list_item_open":
        appendListPrefix(state);
        break;
      case "list_item_close":
        appendText(state, "\n");
        break;
      case "code_block":
      case "fence":
        renderCodeBlock(state, token.content ?? "");
        break;
      case "html_block":
      case "html_inline":
        appendText(state, token.content ?? "");
        break;
      case "table_open":
      case "table_close":
      case "thead_open":
      case "thead_close":
      case "tbody_open":
      case "tbody_close":
        break;
      case "tr_close":
        appendText(state, "\n");
        break;
      case "th_close":
      case "td_close":
        appendText(state, "\t");
        break;
      case "hr":
        appendText(state, "\n");
        break;
      default:
        if (token.children) renderTokens(token.children, state);
        break;
    }
  }
}

function closeRemainingStyles(state: RenderState) {
  for (let i = state.openStyles.length - 1; i >= 0; i -= 1) {
    const open = state.openStyles[i];
    const length = state.text.length - open.start;
    if (length > 0) {
      state.styles.push({
        start: open.start,
        length,
        style: open.style,
      });
    }
  }
  state.openStyles = [];
}

function clampStyles(
  styles: SignalTextStyleRange[],
  maxLength: number,
): SignalTextStyleRange[] {
  const clamped: SignalTextStyleRange[] = [];
  for (const style of styles) {
    const start = Math.max(0, Math.min(style.start, maxLength));
    const end = Math.min(style.start + style.length, maxLength);
    const length = end - start;
    if (length > 0) clamped.push({ start, length, style: style.style });
  }
  return clamped;
}

function mergeStyles(styles: SignalTextStyleRange[]): SignalTextStyleRange[] {
  const sorted = [...styles].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.length !== b.length) return a.length - b.length;
    return a.style.localeCompare(b.style);
  });

  const merged: SignalTextStyleRange[] = [];
  for (const style of sorted) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.style === style.style &&
      style.start <= prev.start + prev.length
    ) {
      const prevEnd = prev.start + prev.length;
      const nextEnd = Math.max(prevEnd, style.start + style.length);
      prev.length = nextEnd - prev.start;
      continue;
    }
    merged.push({ ...style });
  }

  return merged;
}

export function markdownToSignalText(markdown: string): SignalFormattedText {
  const env: RenderEnv = { listStack: [], linkStack: [] };
  const tokens = md.parse(markdown ?? "", env as unknown as object);
  applySpoilerTokens(tokens as MarkdownToken[]);

  const state: RenderState = {
    text: "",
    styles: [],
    openStyles: [],
    env,
  };

  renderTokens(tokens as MarkdownToken[], state);
  closeRemainingStyles(state);

  const trimmedText = state.text.trimEnd();
  const trimmedLength = trimmedText.length;
  const clamped = clampStyles(state.styles, trimmedLength);
  const merged = mergeStyles(clamped);

  return {
    text: trimmedText,
    styles: merged,
  };
}

function sliceStyles(
  styles: SignalTextStyleRange[],
  start: number,
  end: number,
): SignalTextStyleRange[] {
  if (styles.length === 0) return [];
  const sliced: SignalTextStyleRange[] = [];
  for (const style of styles) {
    const styleEnd = style.start + style.length;
    const sliceStart = Math.max(style.start, start);
    const sliceEnd = Math.min(styleEnd, end);
    if (sliceEnd > sliceStart) {
      sliced.push({
        start: sliceStart - start,
        length: sliceEnd - sliceStart,
        style: style.style,
      });
    }
  }
  return mergeStyles(sliced);
}

export function chunkSignalText(
  formatted: SignalFormattedText,
  limit: number,
): SignalFormattedText[] {
  if (!formatted.text) return [];
  if (limit <= 0 || formatted.text.length <= limit) return [formatted];

  const chunks = chunkText(formatted.text, limit);
  const results: SignalFormattedText[] = [];
  let cursor = 0;

  chunks.forEach((chunk, index) => {
    if (!chunk) return;
    if (index > 0) {
      while (cursor < formatted.text.length && /\s/.test(formatted.text[cursor])) {
        cursor += 1;
      }
    }
    const start = cursor;
    const end = Math.min(formatted.text.length, start + chunk.length);
    const styles = sliceStyles(formatted.styles, start, end);
    results.push({ text: chunk, styles });
    cursor = end;
  });

  return results;
}
