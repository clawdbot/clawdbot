import type { MarkdownIR } from "openclaw/plugin-sdk/text-chunking";
import { TextStyle, type Style } from "./zca-constants.js";

export type MarkdownBlockMetadata = {
  kind: "blockquote" | "code_block" | "heading" | "thematic_break";
  start: number;
  end: number;
  depth: number;
  blockquoteDepth?: number;
  codeOrigin?: "fenced" | "indented";
  codeClosed?: boolean;
  headingLevel?: number;
  headingOrigin?: "atx" | "setext";
  language?: string;
  sourceStartLine?: number;
  sourceEndLine?: number;
};

/** Bundled transport view of non-enumerable parser metadata; keep it in lockstep with markdown-core. */
export type MarkdownIRWithBlockMetadata = Omit<MarkdownIR, "listItems"> & {
  blocks?: MarkdownBlockMetadata[];
  listItems?: Array<
    NonNullable<MarkdownIR["listItems"]>[number] & {
      contentStart?: number;
      contentEnd?: number;
      markerOnly?: true;
      sourceMarker?: { start: number; end: number };
      sourceContent?: { start: number; end: number };
      sourceIndent?: number;
      sourceStartLine?: number;
      sourceEndLine?: number;
    }
  >;
};

export type InlineStyle = (typeof TextStyle)[keyof typeof TextStyle];

export type StructuralStyle = {
  start: number;
  end: number;
  style: InlineStyle;
  indentSize?: number;
  priority: number;
};

export type TextEdit = {
  start: number;
  end: number;
  text: string;
  indentSize?: number;
  listStyle?: InlineStyle;
};

export const TAG_STYLE_MAP: Record<string, InlineStyle | null> = {
  red: TextStyle.Red,
  orange: TextStyle.Orange,
  yellow: TextStyle.Yellow,
  green: TextStyle.Green,
  small: null,
  big: TextStyle.Big,
  underline: TextStyle.Underline,
};

export type LocalToken =
  | { kind: "literal"; text: string }
  | { kind: "tag-open"; id: number; style: InlineStyle | null }
  | { kind: "tag-close"; id: number };

export type TokenRegistry = {
  nextId: number;
  prefix: string;
  tokens: Map<string, LocalToken>;
};

export type OrderedStyle = Style & { rawStart: number; rawEnd: number };

export const ZALOUSER_STYLE_MAP = {
  bold: TextStyle.Bold,
  italic: TextStyle.Italic,
  underline: TextStyle.Underline,
  strikethrough: TextStyle.StrikeThrough,
  heading_1: TextStyle.Bold,
  heading_2: TextStyle.Bold,
  heading_3: TextStyle.Bold,
  heading_4: TextStyle.Bold,
} as const;

export const LOCAL_TAG_PATTERN = new RegExp(
  `\\{(${Object.keys(TAG_STYLE_MAP).join("|")})\\}(.+?)\\{/\\1\\}`,
  "g",
);

export const UNICODE_SEPARATOR_PATTERN =
  /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/u;

export function projectOffset(offsets: number[], offset: number): number {
  return offsets[Math.max(0, Math.min(offset, offsets.length - 1))] ?? offsets.at(-1) ?? 0;
}

export function normalizeCodeBlockLeadingWhitespace(line: string): string {
  return line.replace(/^[ \t]+/, (leadingWhitespace) =>
    leadingWhitespace.replace(/\t/g, "\u00A0\u00A0\u00A0\u00A0").replace(/ /g, "\u00A0"),
  );
}
