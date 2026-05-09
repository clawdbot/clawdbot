/**
 * Markdown parser for workspace files: frontmatter + preamble + H2
 * blocks (with bullet items as the only addressable structural child).
 * Tokenization via markdown-it; frontmatter handled here.
 *
 * Grammar opinions (indented `##`, empty `## `, ordered lists, nested
 * sub-bullets) live in lint rules, not the parser.
 *
 * Byte-fidelity: `emitMd(parse(raw)) === raw`.
 *
 * @module @openclaw/oc-path/parse
 */

import MarkdownIt from "markdown-it";

import type {
  AstBlock,
  AstItem,
  Diagnostic,
  FrontmatterEntry,
  ParseResult,
} from "./ast.js";
import { slugify } from "./slug.js";

type Token = ReturnType<MarkdownIt["parse"]>[number];

const FENCE = "---";
const BOM = "﻿";
const KV_RE = /^([^:]+?)\s*:\s*(.+)$/;

const md = new MarkdownIt({ html: true });

export function parseMd(raw: string): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const withoutBom = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;
  const lines = withoutBom.split(/\r?\n/);

  const fm = detectFrontmatter(lines, diagnostics);
  const bodyStartIdx = fm === null ? 0 : fm.endLine + 1;
  const bodyLines = lines.slice(bodyStartIdx);
  const bodyFileLine = bodyStartIdx + 1;

  const tokens = md.parse(bodyLines.join("\n"), {});
  const { preamble, blocks } = walkBlocks(tokens, bodyLines, bodyFileLine);

  return {
    ast: { kind: "md", raw, frontmatter: fm?.entries ?? [], preamble, blocks },
    diagnostics,
  };
}

// ---------- Frontmatter ---------------------------------------------------

interface FrontmatterRange {
  readonly entries: readonly FrontmatterEntry[];
  /** 0-based line index of the closing `---`. */
  readonly endLine: number;
}

function detectFrontmatter(
  lines: readonly string[],
  diagnostics: Diagnostic[],
): FrontmatterRange | null {
  if (lines.length < 2 || lines[0] !== FENCE) {
    return null;
  }
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FENCE) {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) {
    diagnostics.push({
      line: 1,
      message: "frontmatter opens with --- but never closes",
      severity: "warning",
      code: "OC_FRONTMATTER_UNCLOSED",
    });
    return null;
  }
  const entries: FrontmatterEntry[] = [];
  for (let i = 1; i < closeIndex; i++) {
    const m = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (m !== null) {
      entries.push({ key: m[1], value: unquote(m[2].trim()), line: i + 1 });
    }
  }
  return { entries, endLine: closeIndex };
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const f = value.charCodeAt(0);
    const l = value.charCodeAt(value.length - 1);
    if (f === l && (f === 34 || f === 39)) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// ---------- H2 block walker -----------------------------------------------

function walkBlocks(
  tokens: readonly Token[],
  bodyLines: readonly string[],
  bodyFileLine: number,
): { preamble: string; blocks: AstBlock[] } {
  // Match atx `##` only; setext h2 has `markup: "-"`.
  const h2: { tokenIdx: number; lineIdx: number; text: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "heading_open" && t.tag === "h2" && t.markup === "##" && t.map !== null) {
      const inline = tokens[i + 1];
      h2.push({ tokenIdx: i, lineIdx: t.map[0], text: inline?.content ?? "" });
    }
  }

  if (h2.length === 0) {
    return { preamble: bodyLines.join("\n"), blocks: [] };
  }

  const preamble = bodyLines.slice(0, h2[0].lineIdx).join("\n");
  const blocks: AstBlock[] = [];

  for (let h = 0; h < h2.length; h++) {
    const start = h2[h].lineIdx;
    const end = h + 1 < h2.length ? h2[h + 1].lineIdx : bodyLines.length;
    // Slice by INDEX so unmapped descendants (cells, markers, inline)
    // ride along with their parent. h2 = open + inline + close = 3.
    const tokenStart = h2[h].tokenIdx + 3;
    const tokenEnd = h + 1 < h2.length ? h2[h + 1].tokenIdx : tokens.length;
    const blockTokens = tokens.slice(tokenStart, tokenEnd);
    blocks.push({
      heading: h2[h].text,
      slug: slugify(h2[h].text),
      line: bodyFileLine + start,
      bodyText: bodyLines.slice(start + 1, end).join("\n"),
      items: extractItems(blockTokens, bodyFileLine),
    });
  }

  return { preamble, blocks };
}

// ---------- Item extraction ----------------------------------------------

// Every list_item_open becomes an item (bullets, numbered, nested
// sub-bullets); lint rules flag depth / duplicate-slug collisions.
function extractItems(tokens: readonly Token[], bodyFileLine: number): AstItem[] {
  const items: AstItem[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "list_item_open" || t.map === null) {continue;}
    // First inline at the item's own depth is the item text.
    let nestedDepth = 0;
    let text = "";
    for (let j = i + 1; j < tokens.length; j++) {
      const x = tokens[j];
      if (x.type === "list_item_close" && nestedDepth === 0) {
        break;
      }
      if (x.type === "bullet_list_open" || x.type === "ordered_list_open") {
        nestedDepth++;
      } else if (x.type === "bullet_list_close" || x.type === "ordered_list_close") {
        nestedDepth--;
      } else if (x.type === "inline" && nestedDepth === 0 && text === "") {
        text = x.content;
      }
    }
    const kvMatch = KV_RE.exec(text);
    items.push({
      text,
      slug: kvMatch ? slugify(kvMatch[1]) : slugify(text),
      line: bodyFileLine + t.map[0],
      ...(kvMatch !== null
        ? { kv: { key: kvMatch[1].trim(), value: kvMatch[2].trim() } }
        : {}),
    });
  }
  return items;
}
