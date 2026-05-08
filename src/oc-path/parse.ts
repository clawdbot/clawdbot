/**
 * Generic markdown-flavored parser for the 8 workspace files.
 *
 * Produces a `MdAst` addressing index over `raw` bytes:
 * frontmatter (if present), preamble (prose before first H2), and an
 * H2-block tree with items/tables/code-blocks extracted for OcPath
 * resolution.
 *
 * **No file-kind discrimination.** Same parse path for SOUL.md /
 * AGENTS.md / MEMORY.md / TOOLS.md / IDENTITY.md / USER.md /
 * HEARTBEAT.md / SKILL.md. Per-file lint opinions ride downstream
 * (`@openclaw/oc-lint` rule packs).
 *
 * **Byte-fidelity contract**: `raw` is preserved on the AST root so
 * `emitMd(parse(raw)) === raw` for every input the parser accepts.
 *
 * @module @openclaw/oc-path/parse
 */

import type {
  AstBlock,
  AstCodeBlock,
  AstItem,
  AstTable,
  Diagnostic,
  FrontmatterEntry,
  ParseResult,
  MdAst,
} from './ast.js';
import { slugify } from './slug.js';

const FENCE = '---';
const BOM = '﻿';

/**
 * Parse raw bytes into a `MdAst`. Soft-error policy: never
 * throws. Suspicious-but-recoverable inputs (unclosed frontmatter,
 * malformed bullet) become diagnostics.
 */
export function parseMd(raw: string): ParseResult {
  const diagnostics: Diagnostic[] = [];

  // Strip a leading BOM for parsing convenience; keep the raw input
  // intact on the AST so emit can round-trip the BOM if present.
  const withoutBom = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;
  const lines = withoutBom.split(/\r?\n/);

  const fm = detectFrontmatter(lines, diagnostics);
  const bodyStartLine = fm === null ? 0 : fm.endLine + 1;
  const bodyLines = lines.slice(bodyStartLine);

  const { preamble, blocks } = splitH2Blocks(bodyLines, bodyStartLine + 1, diagnostics);

  const ast: MdAst = {
    kind: 'md',
    raw,
    frontmatter: fm?.entries ?? [],
    preamble,
    blocks,
  };

  return { ast, diagnostics };
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
  if (lines.length < 2) {return null;}
  if (lines[0] !== FENCE) {return null;}

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
      message: 'frontmatter opens with --- but never closes',
      severity: 'warning',
      code: 'OC_FRONTMATTER_UNCLOSED',
    });
    return null;
  }

  const entries: FrontmatterEntry[] = [];
  for (let i = 1; i < closeIndex; i++) {
    const line = lines[i];
    if (line.trim().length === 0) {continue;}
    const m = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (m === null) {
      // Could be a list-style continuation (`  - item`) for the previous key;
      // we don't structurally model lists in frontmatter at the substrate
      // layer (lint rules can do that against the raw substring if they
      // need to). Skip silently — keeps the parser opinion-free.
      continue;
    }
    entries.push({
      key: m[1],
      value: unquote(m[2].trim()),
      line: i + 1,
    });
  }

  return { entries, endLine: closeIndex };
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value.charCodeAt(0);
    const last = value.charCodeAt(value.length - 1);
    if (first === last && (first === 34 /* " */ || first === 39 /* ' */)) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// ---------- H2 block split -------------------------------------------------

function splitH2Blocks(
  bodyLines: readonly string[],
  /** 1-based line number of `bodyLines[0]` in the original file. */
  bodyStartLineNum: number,
  diagnostics: Diagnostic[],
): { preamble: string; blocks: AstBlock[] } {
  // Track code-block state so `##` inside a fenced block doesn't get
  // parsed as a heading.
  let inCode = false;
  const headings: { line: number; text: string }[] = [];

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {continue;}
    const m = /^##\s+(\S.*?)\s*$/.exec(line);
    if (m !== null) {
      headings.push({ line: i, text: m[1] });
    }
  }

  if (headings.length === 0) {
    return {
      preamble: bodyLines.join('\n'),
      blocks: [],
    };
  }

  const preamble = bodyLines.slice(0, headings[0].line).join('\n');
  const blocks: AstBlock[] = [];

  for (let h = 0; h < headings.length; h++) {
    const start = headings[h].line;
    const end = h + 1 < headings.length ? headings[h + 1].line : bodyLines.length;
    const headingText = headings[h].text;
    const blockBodyLines = bodyLines.slice(start + 1, end);
    const bodyText = blockBodyLines.join('\n');
    const headingLineNum = bodyStartLineNum + start;

    const items = extractItems(blockBodyLines, headingLineNum + 1, diagnostics);
    const tables = extractTables(blockBodyLines, headingLineNum + 1);
    const codeBlocks = extractCodeBlocks(blockBodyLines, headingLineNum + 1);

    blocks.push({
      heading: headingText,
      slug: slugify(headingText),
      line: headingLineNum,
      bodyText,
      items,
      tables,
      codeBlocks,
    });
  }

  return { preamble, blocks };
}

// ---------- Items ----------------------------------------------------------

const BULLET_RE = /^(?:[-*+])\s+(.+?)\s*$/;
const KV_RE = /^([^:]+?)\s*:\s*(.+)$/;

function extractItems(
  blockBodyLines: readonly string[],
  startLineNum: number,
  _diagnostics: Diagnostic[],
): AstItem[] {
  const items: AstItem[] = [];
  let inCode = false;

  for (let i = 0; i < blockBodyLines.length; i++) {
    const line = blockBodyLines[i];
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {continue;}
    const m = BULLET_RE.exec(line);
    if (m === null) {continue;}
    const text = m[1];
    const kvMatch = KV_RE.exec(text);
    const item: AstItem = {
      text,
      slug: kvMatch ? slugify(kvMatch[1]) : slugify(text),
      line: startLineNum + i,
      ...(kvMatch !== null
        ? { kv: { key: kvMatch[1].trim(), value: kvMatch[2].trim() } }
        : {}),
    };
    items.push(item);
  }

  return items;
}

// ---------- Tables ---------------------------------------------------------

function extractTables(
  blockBodyLines: readonly string[],
  startLineNum: number,
): AstTable[] {
  const tables: AstTable[] = [];
  let i = 0;
  while (i < blockBodyLines.length) {
    const headerLine = blockBodyLines[i];
    const sepLine = blockBodyLines[i + 1];
    if (
      headerLine.trim().startsWith('|') &&
      sepLine !== undefined &&
      /^\s*\|\s*[:-]+(?:\s*\|\s*[:-]+)*\s*\|?\s*$/.test(sepLine)
    ) {
      const headers = splitTableRow(headerLine);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < blockBodyLines.length && blockBodyLines[j].trim().startsWith('|')) {
        rows.push(splitTableRow(blockBodyLines[j]));
        j++;
      }
      tables.push({ headers, rows, line: startLineNum + i });
      i = j;
      continue;
    }
    i++;
  }
  return tables;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

// ---------- Code blocks ---------------------------------------------------

function extractCodeBlocks(
  blockBodyLines: readonly string[],
  startLineNum: number,
): AstCodeBlock[] {
  const codeBlocks: AstCodeBlock[] = [];
  let i = 0;
  while (i < blockBodyLines.length) {
    const open = blockBodyLines[i];
    if (open.startsWith('```')) {
      const lang = open.slice(3).trim();
      const langField = lang.length > 0 ? lang : null;
      const startLine = startLineNum + i;
      let j = i + 1;
      const bodyLines: string[] = [];
      while (j < blockBodyLines.length && !blockBodyLines[j].startsWith('```')) {
        bodyLines.push(blockBodyLines[j]);
        j++;
      }
      codeBlocks.push({ lang: langField, text: bodyLines.join('\n'), line: startLine });
      i = j + 1;
      continue;
    }
    i++;
  }
  return codeBlocks;
}
