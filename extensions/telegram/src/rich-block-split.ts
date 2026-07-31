// Chunk-limit enforcement for typed rich blocks: surrogate-safe, wrapper- and
// caption-preserving splitting against the live-verified Bot API limits.
import {
  countInputRichBlockChars,
  countInputRichBlockMedia,
  countRichTextChars,
  normalizeRichText,
  type InputRichBlock,
  type InputRichBlockListItem,
  type RichBlockTableCell,
  type RichText,
} from "./rich-block-model.js";
import { splitTelegramPlainTextChunks, surrogateSafeChunkEnd } from "./rich-plain-fallback.js";

type RichTextStyleWrap =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "code"
  | "spoiler"
  | "marked"
  | "subscript"
  | "superscript";
type RichTextWrapper =
  | { type: RichTextStyleWrap }
  | { type: "url"; url: string }
  | { type: "anchor_link"; anchor_name: string };

function wrapRichTextFragment(fragment: RichText, wrappers: readonly RichTextWrapper[]): RichText {
  let node = fragment;
  for (let index = wrappers.length - 1; index >= 0; index -= 1) {
    const wrapper = wrappers[index];
    if (!wrapper) {
      continue;
    }
    node =
      wrapper.type === "url"
        ? { type: "url", text: node, url: wrapper.url }
        : wrapper.type === "anchor_link"
          ? { type: "anchor_link", text: node, anchor_name: wrapper.anchor_name }
          : { type: wrapper.type, text: node };
  }
  return node;
}

// Split a RichText tree into pieces of at most `limit` plain chars, duplicating
// style/link wrappers across boundaries so link targets survive the split.
function splitRichTextByChars(text: RichText, limit: number): RichText[] {
  const pieces: RichText[] = [];
  let current: RichText[] = [];
  let chars = 0;
  const flush = () => {
    if (current.length > 0) {
      pieces.push(normalizeRichText(current));
      current = [];
      chars = 0;
    }
  };
  const visit = (node: RichText, wrappers: readonly RichTextWrapper[]) => {
    if (typeof node === "string") {
      let offset = 0;
      while (offset < node.length) {
        if (chars >= limit) {
          flush();
        }
        const budget = limit - chars;
        const end = surrogateSafeChunkEnd(node, Math.min(node.length, offset + budget), offset);
        const fragment = node.slice(offset, end);
        current.push(wrapRichTextFragment(fragment, wrappers));
        chars += fragment.length;
        offset = end;
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        visit(child, wrappers);
      }
      return;
    }
    if (node.type === "mathematical_expression" || node.type === "custom_emoji") {
      // Atomic leaves: never sliced, only placed whole into the current piece.
      const atomicChars = countRichTextChars(node);
      if (chars > 0 && chars + atomicChars > limit) {
        flush();
      }
      current.push(wrapRichTextFragment(node, wrappers));
      chars += atomicChars;
      return;
    }
    const wrapper: RichTextWrapper =
      node.type === "url"
        ? { type: "url", url: node.url }
        : node.type === "anchor_link"
          ? { type: "anchor_link", anchor_name: node.anchor_name }
          : { type: node.type };
    visit(node.text, [...wrappers, wrapper]);
  };
  visit(text, []);
  flush();
  return pieces;
}

function splitOversizedRichBlock(block: InputRichBlock, textLimit: number): InputRichBlock[] {
  if (countInputRichBlockChars(block) <= textLimit) {
    return [block];
  }
  if (block.type === "pre") {
    const language = block.language;
    return splitTelegramPlainTextChunks(block.text, textLimit).map((piece) =>
      language ? { type: "pre", text: piece, language } : { type: "pre", text: piece },
    );
  }
  if (block.type === "paragraph" || block.type === "heading") {
    return splitRichTextByChars(block.text, textLimit).map((piece) =>
      block.type === "heading"
        ? { type: "heading", text: piece, size: block.size }
        : { type: "paragraph", text: piece },
    );
  }
  if (block.type === "blockquote") {
    // Reserve the credit's chars while splitting the body, then attach the
    // credit to the final piece only (attribution belongs at the quote's end).
    const creditChars = countRichTextChars(block.credit ?? "");
    const innerLimit = Math.max(1, textLimit - creditChars);
    const pieces = splitTelegramRichBlocks(block.blocks, { textLimit: innerLimit });
    return pieces.map((inner, index) =>
      index === pieces.length - 1 && block.credit !== undefined
        ? { type: "blockquote", blocks: inner, credit: block.credit }
        : { type: "blockquote", blocks: inner },
    );
  }
  if (block.type === "table") {
    // Row-splitting a table with rowspans would strand spans across messages;
    // such tables stay atomic and degrade via the TEXT_TOO_LONG fallback.
    if (block.cells.some((row) => row.some((cell) => (cell.rowspan ?? 1) > 1))) {
      return [block];
    }
    const { caption, ...tableRest } = block;
    const pieces: InputRichBlock[] = [];
    const pushPiece = (pieceRows: RichBlockTableCell[][]) => {
      // The caption rides only the first piece.
      pieces.push(
        pieces.length === 0 && caption !== undefined
          ? { ...tableRest, cells: pieceRows, caption }
          : { ...tableRest, cells: pieceRows },
      );
    };
    let rows: RichBlockTableCell[][] = [];
    let chars = countRichTextChars(caption ?? "");
    for (const row of block.cells) {
      const rowChars = row.reduce((total, cell) => total + countRichTextChars(cell.text ?? ""), 0);
      if (rows.length > 0 && chars + rowChars > textLimit) {
        pushPiece(rows);
        rows = [];
        chars = 0;
      }
      rows.push(row);
      chars += rowChars;
    }
    if (rows.length > 0) {
      pushPiece(rows);
    }
    return pieces;
  }
  if (block.type === "list") {
    const pieces: InputRichBlock[] = [];
    let items: InputRichBlockListItem[] = [];
    let chars = 0;
    for (const item of block.items) {
      const itemChars = item.blocks.reduce(
        (total, child) => total + countInputRichBlockChars(child),
        0,
      );
      if (items.length > 0 && chars + itemChars > textLimit) {
        pieces.push({ type: "list", items });
        items = [];
        chars = 0;
      }
      items.push(item);
      chars += itemChars;
    }
    if (items.length > 0) {
      pieces.push({ type: "list", items });
    }
    return pieces;
  }
  // Details, media, and remaining container blocks stay atomic; a genuinely
  // oversized one degrades via the RICH_MESSAGE_TEXT_TOO_LONG plain fallback.
  return [block];
}

// Chunking is locality-blind for anchors: an anchor_link whose target lands in
// an earlier chunk renders as an inert link. Accepted trade-off — it needs a
// >32k message with cross-chunk fragment links, and delivery is unaffected.
export function splitTelegramRichBlocks(
  blocks: readonly InputRichBlock[],
  options: { blockLimit?: number; textLimit?: number } = {},
): InputRichBlock[][] {
  const blockLimit = Math.max(1, Math.floor(options.blockLimit ?? 500));
  const textLimit = Math.max(1, Math.floor(options.textLimit ?? 32_768));
  if (blocks.length === 0) {
    return [];
  }
  const expanded = blocks.flatMap((block) => splitOversizedRichBlock(block, textLimit));
  const chunks: InputRichBlock[][] = [];
  let current: InputRichBlock[] = [];
  let currentChars = 0;
  // Live-verified message cap: >50 media elements → RICH_MESSAGE_MEDIA_TOO_MANY.
  const mediaLimit = 50;
  let currentMedia = 0;

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = [];
      currentChars = 0;
      currentMedia = 0;
    }
  };
  for (const block of expanded) {
    const chars = countInputRichBlockChars(block);
    const media = countInputRichBlockMedia(block);
    const wouldExceedBlocks = current.length >= blockLimit;
    const wouldExceedChars = current.length > 0 && currentChars + chars > textLimit;
    const wouldExceedMedia = current.length > 0 && currentMedia + media > mediaLimit;
    if (wouldExceedBlocks || wouldExceedChars || wouldExceedMedia) {
      flush();
    }
    current.push(block);
    currentChars += chars;
    currentMedia += media;
  }
  flush();
  return chunks;
}
