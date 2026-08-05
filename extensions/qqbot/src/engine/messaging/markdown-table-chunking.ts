// QQ Bot Markdown chunking keeps each sent message self-contained.

import { formatQQBotMarkdown } from "./markdown-format.js";

type QQBotBaseMarkdownChunker = (text: string, limit: number) => string[];

const QQBOT_MARKDOWN_SAFE_CHUNK_BYTE_LIMIT = 3600;

type TableHeader = {
  header: string;
  separator: string;
  cells: string[];
};

type ActiveFence = {
  openLine: string;
  closeLine: string;
  marker: string;
};

type QQBotMarkdownChunker = {
  chunkText: (text: string, limit: number) => string[];
  flushPendingText: (limit: number) => string[];
};

export function chunkQQBotMarkdownText(
  text: string,
  limit: number,
  baseChunker: QQBotBaseMarkdownChunker,
): string[] {
  const chunker = createQQBotMarkdownChunker(baseChunker);
  return [...chunker.chunkText(text, limit), ...chunker.flushPendingText(limit)];
}

export function createQQBotMarkdownChunker(
  baseChunker: QQBotBaseMarkdownChunker,
): QQBotMarkdownChunker {
  const state = new QQBotMarkdownChunkingState(baseChunker);
  return {
    chunkText: (text, limit) => state.chunkText(text, limit),
    flushPendingText: (limit) => state.flushPendingText(limit),
  };
}

class QQBotMarkdownChunkingState {
  private activeTable: TableHeader | null = null;
  private pendingHeaderLine: string | null = null;
  private pendingHeaderCells: string[] = [];
  private tableLines: string[] = [];
  private textLines: string[] = [];
  private pendingRowFragment: string | null = null;
  private activeFence: ActiveFence | null = null;
  private pendingTextFenceOpenLine: string | null = null;
  private pendingFenceLineFragment: string | null = null;

  constructor(private readonly baseChunker: QQBotBaseMarkdownChunker) {}

  chunkText(text: string, limit: number): string[] {
    if (!text) {
      return [];
    }
    if (limit <= 0) {
      return this.baseChunker(text, limit);
    }
    const chunkLimit = resolveQQBotMarkdownChunkLimit(limit);

    const chunks: string[] = [];
    const textWithPendingRow = this.consumePendingRowPrefix(text);
    const textWithPendingFenceLine = this.consumePendingFenceLinePrefix(textWithPendingRow);
    const hasTrailingNewline = textWithPendingFenceLine.endsWith("\n");
    const lines = textWithPendingFenceLine.split("\n");
    for (const [index, line] of lines.entries()) {
      const isTrailingSplitLine = index === lines.length - 1 && line === "";
      this.consumeLine(line, {
        limit: chunkLimit,
        chunks,
        hasTrailingNewline,
        isTrailingSplitLine,
        isLastLine: index === lines.length - 1,
      });
    }
    this.flushText(chunks, chunkLimit);
    this.flushTable(chunks);
    return chunks;
  }

  flushPendingText(limit: number): string[] {
    const chunkLimit = resolveQQBotMarkdownChunkLimit(limit);
    const chunks: string[] = [];
    this.flushPendingRowFragment(chunks, chunkLimit);
    this.flushPendingFenceLineFragment();
    this.flushPendingHeaderAsText();
    this.flushText(chunks, chunkLimit);
    this.flushTable(chunks);
    return chunks;
  }

  private consumeLine(
    line: string,
    params: {
      limit: number;
      chunks: string[];
      hasTrailingNewline: boolean;
      isTrailingSplitLine: boolean;
      isLastLine: boolean;
    },
  ): void {
    const fence = parseFenceLine(line);
    if (fence) {
      this.endTable(params.chunks);
      if (!this.activeFence) {
        this.pushTextLine(line);
        this.activeFence = fence;
        this.clearPendingTableHeader();
        return;
      }
      if (isClosingFenceLine(line, this.activeFence)) {
        this.pushFenceTextLine(line);
        this.activeFence = null;
        this.clearPendingTableHeader();
        return;
      }
      this.pushFenceTextLine(line);
      this.clearPendingTableHeader();
      return;
    }

    if (this.activeFence) {
      if (params.isLastLine && !params.hasTrailingNewline) {
        this.pendingFenceLineFragment = mergeFenceLineFragments(
          this.pendingFenceLineFragment,
          line,
        );
        return;
      }
      this.pushFenceTextLine(line);
      return;
    }

    if (
      isIncompleteTableRowFragment(line) ||
      (this.activeTable && isShortTableRowLine(line, this.activeTable))
    ) {
      if (params.isLastLine) {
        this.flushText(params.chunks, params.limit);
        this.pendingRowFragment = mergeRowFragments(this.pendingRowFragment, line);
        return;
      }
      this.pushTextLine(renderMalformedPipeLineAsText(line));
      return;
    }

    if (this.pendingHeaderLine && isTableSeparatorLine(line)) {
      this.flushText(params.chunks, params.limit);
      this.activeTable = {
        header: this.pendingHeaderLine,
        separator: line,
        cells: this.pendingHeaderCells,
      };
      this.pendingHeaderLine = null;
      this.pendingHeaderCells = [];
      this.ensureTableHeader();
      return;
    }

    if (isTableRowLine(line) && this.activeTable && !isTableSeparatorLine(line)) {
      this.flushText(params.chunks, params.limit);
      this.appendTableRow(line, params.limit, params.chunks);
      return;
    }

    if (this.activeTable) {
      if (!line.trim() && params.isTrailingSplitLine) {
        return;
      }
      this.endTable(params.chunks);
    }

    if (isTableRowLine(line) && !isTableSeparatorLine(line)) {
      this.flushText(params.chunks, params.limit);
      this.pendingHeaderLine = line;
      this.pendingHeaderCells = splitTableCells(line);
      return;
    }

    this.flushPendingHeaderAsText();
    this.pushTextLine(line);
  }

  private pushTextLine(line: string): void {
    this.textLines.push(line);
  }

  private pushFenceTextLine(line: string): void {
    if (this.textLines.length === 0 && this.activeFence) {
      this.pendingTextFenceOpenLine = this.activeFence.openLine;
    }
    this.textLines.push(line);
  }

  private appendTableRow(line: string, limit: number, chunks: string[]): void {
    const rowMessage = [this.activeTable!.header, this.activeTable!.separator, line].join("\n");
    if (utf8ByteLength(rowMessage) > limit) {
      this.dropHeaderOnlyTableChunk();
      this.flushTable(chunks);
      this.pushOversizedTableRow(line, limit, chunks);
      return;
    }

    this.ensureTableHeader();
    const candidate = [...this.tableLines, line].join("\n");
    if (utf8ByteLength(candidate) <= limit) {
      this.tableLines.push(line);
      return;
    }

    this.flushTable(chunks);
    this.ensureTableHeader();
    this.tableLines.push(line);
  }

  private pushOversizedTableRow(line: string, limit: number, chunks: string[]): void {
    const text = renderTableRowAsFields(this.activeTable!.cells, splitTableCells(line));
    pushBaseChunks(chunks, text, limit, this.baseChunker);
  }

  private ensureTableHeader(): void {
    if (this.tableLines.length > 0 || !this.activeTable) {
      return;
    }
    this.tableLines.push(this.activeTable.header, this.activeTable.separator);
  }

  private flushText(chunks: string[], limit: number): void {
    if (this.textLines.length === 0) {
      return;
    }
    const continuedFenceOpenLine = this.activeFence?.openLine;
    let text = this.textLines.join("\n");
    this.textLines = [];
    if (this.pendingTextFenceOpenLine) {
      text = `${this.pendingTextFenceOpenLine}\n${text}`;
      this.pendingTextFenceOpenLine = null;
    }
    if (this.activeFence) {
      text = `${text}\n${this.activeFence.closeLine}`;
    }
    if (!text) {
      return;
    }
    chunks.push(...formatQQBotMarkdown(text, limit));
    if (continuedFenceOpenLine) {
      this.pendingTextFenceOpenLine = continuedFenceOpenLine;
    }
  }

  private consumePendingFenceLinePrefix(text: string): string {
    if (!this.pendingFenceLineFragment) {
      return text;
    }
    const firstLine = text.split("\n", 1)[0] ?? "";
    const startsWithClosingFence =
      this.activeFence && isClosingFenceLine(firstLine, this.activeFence);
    const separator =
      !startsWithClosingFence && shouldJoinFenceLineFragments(this.pendingFenceLineFragment, text)
        ? ""
        : "\n";
    const merged = `${this.pendingFenceLineFragment}${separator}${text}`;
    this.pendingFenceLineFragment = null;
    return merged;
  }

  private flushPendingFenceLineFragment(): void {
    if (!this.pendingFenceLineFragment) {
      return;
    }
    this.pushFenceTextLine(this.pendingFenceLineFragment);
    this.pendingFenceLineFragment = null;
  }

  private flushPendingHeaderAsText(): void {
    if (!this.pendingHeaderLine) {
      return;
    }
    this.pushTextLine(this.pendingHeaderLine);
    this.pendingHeaderLine = null;
    this.pendingHeaderCells = [];
  }

  private clearPendingTableHeader(): void {
    this.pendingHeaderLine = null;
    this.pendingHeaderCells = [];
  }

  private consumePendingRowPrefix(text: string): string {
    if (!this.pendingRowFragment) {
      return text;
    }
    const separator =
      this.pendingRowFragment.trimEnd().endsWith("|") && text && !/^[\s|]/.test(text) ? " " : "";
    const merged = `${this.pendingRowFragment}${separator}${text}`;
    this.pendingRowFragment = null;
    return merged;
  }

  private flushPendingRowFragment(chunks: string[], limit: number): void {
    if (!this.pendingRowFragment) {
      return;
    }
    const fragment = this.pendingRowFragment;
    this.pendingRowFragment = null;
    const text = this.activeTable
      ? renderTableRowAsFields(this.activeTable.cells, splitPartialTableCells(fragment))
      : renderMalformedPipeLineAsText(fragment);
    pushBaseChunks(chunks, text, limit, this.baseChunker);
  }

  private flushTable(chunks: string[]): void {
    if (this.tableLines.length === 0) {
      return;
    }
    chunks.push(this.tableLines.join("\n"));
    this.tableLines = [];
  }

  private dropHeaderOnlyTableChunk(): void {
    if (
      this.activeTable &&
      this.tableLines.length === 2 &&
      this.tableLines[0] === this.activeTable.header &&
      this.tableLines[1] === this.activeTable.separator
    ) {
      this.tableLines = [];
    }
  }

  private endTable(chunks: string[]): void {
    this.flushTable(chunks);
    this.activeTable = null;
  }
}

function isTableRowLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && splitTableCells(trimmed).length >= 2;
}

function resolveQQBotMarkdownChunkLimit(limit: number): number {
  return Math.min(limit, QQBOT_MARKDOWN_SAFE_CHUNK_BYTE_LIMIT);
}

function pushBaseChunks(
  chunks: string[],
  text: string,
  byteLimit: number,
  baseChunker: QQBotBaseMarkdownChunker,
): void {
  const baseChunks = baseChunker(text, byteLimit).filter(Boolean);
  for (let index = 0; index + 1 < baseChunks.length; index += 1) {
    const chunk = baseChunks[index] ?? "";
    if (!/(^|[^\\])(?:\\\\)*\\$/u.test(chunk)) {
      continue;
    }
    const next = baseChunks[index + 1] ?? "";
    const firstCodePoint = next.codePointAt(0);
    const first = firstCodePoint === undefined ? "" : String.fromCodePoint(firstCodePoint);
    if (first && utf8ByteLength(chunk + first) <= byteLimit) {
      baseChunks[index] = chunk + first;
      baseChunks[index + 1] = next.slice(first.length);
    } else {
      baseChunks[index] = chunk.slice(0, -1);
      baseChunks[index + 1] = `\\${next}`;
    }
  }
  for (const chunk of baseChunks) {
    if (!chunk) {
      continue;
    }
    if (utf8ByteLength(chunk) <= byteLimit) {
      chunks.push(chunk);
      continue;
    }
    chunks.push(...splitByUtf8ByteLimit(chunk, byteLimit));
  }
}

function splitByUtf8ByteLimit(text: string, byteLimit: number): string[] {
  if (!text) {
    return [];
  }
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  const chars = Array.from(text);
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] ?? "";
    const escapedUnit = char === "\\" && chars[index + 1] ? `${char}${chars[index + 1]}` : "";
    const unit =
      escapedUnit && utf8ByteLength(escapedUnit) <= byteLimit ? `${char}${chars[++index]}` : char;
    const unitBytes = utf8ByteLength(unit);
    if (current && currentBytes + unitBytes > byteLimit) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += unit;
    currentBytes += unitBytes;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function isIncompleteTableRowFragment(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("|") && !trimmed.endsWith("|") && splitPartialTableCells(trimmed).length >= 2
  );
}

function isShortTableRowLine(line: string, table: TableHeader): boolean {
  if (!isTableRowLine(line) || isTableSeparatorLine(line)) {
    return false;
  }
  return splitTableCells(line).length < table.cells.length;
}

function isTableSeparatorLine(line: string): boolean {
  if (!isTableRowLine(line)) {
    return false;
  }
  const cells = splitTableCells(line);
  // GFM delimiter cells need only one or more hyphens (optionally colon-aligned), so accept "-+",
  // not "-{3,}": a valid 1/2-dash separator (e.g. |--|--|) was not recognized here, leaving the
  // header pending and silently overwritten by later rows so the table's header and rows vanished.
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

// Split a markdown table row's inner text on its column delimiters. A
// backslash-escaped pipe (`\|`) is literal cell content per GFM, not a column
// delimiter, so it must not start a new cell; it is unescaped to a bare `|`.
// (`\\` is likewise unescaped to a single backslash so a following `|` still
// delimits.) Splitting on every `|` previously mis-counted columns whenever a
// cell contained an escaped pipe.
function splitTableRowCells(inner: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (char === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1];
      current += next === "|" || next === "\\" ? next : `\\${next}`;
      i++;
      continue;
    }
    if (char === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

function splitTableCells(line: string): string[] {
  return splitTableRowCells(line.trim().slice(1, -1)).map((cell) => cell.trim());
}

function splitPartialTableCells(line: string): string[] {
  return splitTableRowCells(line.trim().replace(/^\|/, ""))
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

function mergeRowFragments(pending: string | null, next: string): string {
  return pending ? `${pending}${next}` : next;
}

function mergeFenceLineFragments(pending: string | null, next: string): string {
  return pending ? `${pending}${next}` : next;
}

function shouldJoinFenceLineFragments(pending: string, next: string): boolean {
  if (!next || next.startsWith("\n")) {
    return true;
  }
  const trimmedPending = pending.trimEnd();
  const trimmedNext = next.trimStart();
  if (!trimmedPending || !trimmedNext) {
    return true;
  }
  if (/\d\.$/.test(trimmedPending) && /^\d/.test(trimmedNext)) {
    return true;
  }
  if (/[.([{:,+\-*/%=&|^<>\\]$/.test(trimmedPending)) {
    return true;
  }
  return hasUnclosedQuote(trimmedPending) || hasUnclosedDelimiter(trimmedPending);
}

function hasUnclosedQuote(line: string): boolean {
  let single = false;
  let double = false;
  let escaped = false;
  for (const char of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" && !double) {
      single = !single;
      continue;
    }
    if (char === '"' && !single) {
      double = !double;
    }
  }
  return single || double;
}

function hasUnclosedDelimiter(line: string): boolean {
  const stack: string[] = [];
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const closers = new Set(Object.values(pairs));
  for (const char of line) {
    if (pairs[char]) {
      stack.push(pairs[char]);
      continue;
    }
    if (closers.has(char)) {
      if (stack.at(-1) === char) {
        stack.pop();
      }
    }
  }
  return stack.length > 0;
}

function renderMalformedPipeLineAsText(line: string): string {
  return splitPartialTableCells(line).join(" ");
}

function renderTableRowAsFields(headers: string[], cells: string[]): string {
  return cells
    .map((cell, index) => {
      const header = headers[index]?.trim();
      return header ? `${header}: ${cell}` : cell;
    })
    .join("\n");
}

function parseFenceLine(line: string): ActiveFence | null {
  const match = line.match(/^(\s*)(`{3,}|~{3,})/);
  if (!match?.[2]) {
    return null;
  }
  return {
    openLine: line,
    closeLine: `${match[1] ?? ""}${match[2]}`,
    marker: match[2],
  };
}

function isClosingFenceLine(line: string, fence: ActiveFence): boolean {
  const markerChar = fence.marker[0] === "`" ? "`" : "~";
  const match = line.match(/^(\s*)(`{3,}|~{3,})\s*$/);
  return Boolean(
    match?.[2] && match[2][0] === markerChar && match[2].length >= fence.marker.length,
  );
}
