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

export type MarkdownStyle = "bold" | "italic" | "strikethrough" | "code" | "code_block" | "spoiler";

export type MarkdownStyleSpan = {
  start: number;
  end: number;
  style: MarkdownStyle;
};

export type MarkdownLinkSpan = {
  start: number;
  end: number;
  href: string;
};

export type MarkdownIR = {
  text: string;
  styles: MarkdownStyleSpan[];
  links: MarkdownLinkSpan[];
};

type OpenStyle = {
  style: MarkdownStyle;
  start: number;
};

type RenderState = {
  text: string;
  styles: MarkdownStyleSpan[];
  openStyles: OpenStyle[];
  links: MarkdownLinkSpan[];
  env: RenderEnv;
  headingStyle: "none" | "bold";
  blockquotePrefix: string;
  enableSpoilers: boolean;
};

export type MarkdownParseOptions = {
  linkify?: boolean;
  enableSpoilers?: boolean;
  headingStyle?: "none" | "bold";
  blockquotePrefix?: string;
  autolink?: boolean;
};

function createMarkdownIt(options: MarkdownParseOptions): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: options.linkify ?? true,
    breaks: false,
    typographer: false,
  });
  md.enable("strikethrough");
  if (options.autolink === false) {
    md.disable("autolink");
  }
  return md;
}

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

function openStyle(state: RenderState, style: MarkdownStyle) {
  state.openStyles.push({ style, start: state.text.length });
}

function closeStyle(state: RenderState, style: MarkdownStyle) {
  for (let i = state.openStyles.length - 1; i >= 0; i -= 1) {
    if (state.openStyles[i]?.style === style) {
      const start = state.openStyles[i].start;
      state.openStyles.splice(i, 1);
      const end = state.text.length;
      if (end > start) {
        state.styles.push({ start, end, style });
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
  state.styles.push({ start, end: start + content.length, style: "code" });
}

function renderCodeBlock(state: RenderState, content: string) {
  let code = content ?? "";
  if (!code.endsWith("\n")) code = `${code}\n`;
  const start = state.text.length;
  appendText(state, code);
  state.styles.push({ start, end: start + code.length, style: "code_block" });
  if (state.env.listStack.length === 0) {
    appendText(state, "\n");
  }
}

function handleLinkClose(state: RenderState) {
  const link = state.env.linkStack.pop();
  if (!link?.href) return;
  const href = link.href.trim();
  if (!href) return;
  const start = link.labelStart;
  const end = state.text.length;
  if (end <= start) {
    state.links.push({ start, end, href });
    return;
  }
  state.links.push({ start, end, href });
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
        openStyle(state, "italic");
        break;
      case "em_close":
        closeStyle(state, "italic");
        break;
      case "strong_open":
        openStyle(state, "bold");
        break;
      case "strong_close":
        closeStyle(state, "bold");
        break;
      case "s_open":
        openStyle(state, "strikethrough");
        break;
      case "s_close":
        closeStyle(state, "strikethrough");
        break;
      case "code_inline":
        renderInlineCode(state, token.content ?? "");
        break;
      case "spoiler_open":
        if (state.enableSpoilers) openStyle(state, "spoiler");
        break;
      case "spoiler_close":
        if (state.enableSpoilers) closeStyle(state, "spoiler");
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
      case "heading_open":
        if (state.headingStyle === "bold") openStyle(state, "bold");
        break;
      case "heading_close":
        if (state.headingStyle === "bold") closeStyle(state, "bold");
        appendParagraphSeparator(state);
        break;
      case "blockquote_open":
        if (state.blockquotePrefix) appendText(state, state.blockquotePrefix);
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
    const end = state.text.length;
    if (end > open.start) {
      state.styles.push({
        start: open.start,
        end,
        style: open.style,
      });
    }
  }
  state.openStyles = [];
}

function clampStyleSpans(spans: MarkdownStyleSpan[], maxLength: number): MarkdownStyleSpan[] {
  const clamped: MarkdownStyleSpan[] = [];
  for (const span of spans) {
    const start = Math.max(0, Math.min(span.start, maxLength));
    const end = Math.max(start, Math.min(span.end, maxLength));
    if (end > start) clamped.push({ start, end, style: span.style });
  }
  return clamped;
}

function clampLinkSpans(spans: MarkdownLinkSpan[], maxLength: number): MarkdownLinkSpan[] {
  const clamped: MarkdownLinkSpan[] = [];
  for (const span of spans) {
    const start = Math.max(0, Math.min(span.start, maxLength));
    const end = Math.max(start, Math.min(span.end, maxLength));
    if (end > start) clamped.push({ start, end, href: span.href });
  }
  return clamped;
}

function mergeStyleSpans(spans: MarkdownStyleSpan[]): MarkdownStyleSpan[] {
  const sorted = [...spans].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.end !== b.end) return a.end - b.end;
    return a.style.localeCompare(b.style);
  });

  const merged: MarkdownStyleSpan[] = [];
  for (const span of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.style === span.style && span.start <= prev.end) {
      prev.end = Math.max(prev.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

function sliceStyleSpans(
  spans: MarkdownStyleSpan[],
  start: number,
  end: number,
): MarkdownStyleSpan[] {
  if (spans.length === 0) return [];
  const sliced: MarkdownStyleSpan[] = [];
  for (const span of spans) {
    const sliceStart = Math.max(span.start, start);
    const sliceEnd = Math.min(span.end, end);
    if (sliceEnd > sliceStart) {
      sliced.push({
        start: sliceStart - start,
        end: sliceEnd - start,
        style: span.style,
      });
    }
  }
  return mergeStyleSpans(sliced);
}

function sliceLinkSpans(spans: MarkdownLinkSpan[], start: number, end: number): MarkdownLinkSpan[] {
  if (spans.length === 0) return [];
  const sliced: MarkdownLinkSpan[] = [];
  for (const span of spans) {
    const sliceStart = Math.max(span.start, start);
    const sliceEnd = Math.min(span.end, end);
    if (sliceEnd > sliceStart) {
      sliced.push({
        start: sliceStart - start,
        end: sliceEnd - start,
        href: span.href,
      });
    }
  }
  return sliced;
}

export function markdownToIR(markdown: string, options: MarkdownParseOptions = {}): MarkdownIR {
  const env: RenderEnv = { listStack: [], linkStack: [] };
  const md = createMarkdownIt(options);
  const tokens = md.parse(markdown ?? "", env as unknown as object);
  if (options.enableSpoilers) {
    applySpoilerTokens(tokens as MarkdownToken[]);
  }

  const state: RenderState = {
    text: "",
    styles: [],
    openStyles: [],
    links: [],
    env,
    headingStyle: options.headingStyle ?? "none",
    blockquotePrefix: options.blockquotePrefix ?? "",
    enableSpoilers: options.enableSpoilers ?? false,
  };

  renderTokens(tokens as MarkdownToken[], state);
  closeRemainingStyles(state);

  const trimmedText = state.text.trimEnd();
  const trimmedLength = trimmedText.length;
  let codeBlockEnd = 0;
  for (const span of state.styles) {
    if (span.style !== "code_block") continue;
    if (span.end > codeBlockEnd) codeBlockEnd = span.end;
  }
  const finalLength = Math.max(trimmedLength, codeBlockEnd);
  const finalText =
    finalLength === state.text.length ? state.text : state.text.slice(0, finalLength);

  return {
    text: finalText,
    styles: mergeStyleSpans(clampStyleSpans(state.styles, finalLength)),
    links: clampLinkSpans(state.links, finalLength),
  };
}

export function chunkMarkdownIR(ir: MarkdownIR, limit: number): MarkdownIR[] {
  if (!ir.text) return [];
  if (limit <= 0 || ir.text.length <= limit) return [ir];

  const chunks = chunkText(ir.text, limit);
  const results: MarkdownIR[] = [];
  let cursor = 0;

  chunks.forEach((chunk, index) => {
    if (!chunk) return;
    if (index > 0) {
      while (cursor < ir.text.length && /\s/.test(ir.text[cursor] ?? "")) {
        cursor += 1;
      }
    }
    const start = cursor;
    const end = Math.min(ir.text.length, start + chunk.length);
    results.push({
      text: chunk,
      styles: sliceStyleSpans(ir.styles, start, end),
      links: sliceLinkSpans(ir.links, start, end),
    });
    cursor = end;
  });

  return results;
}
