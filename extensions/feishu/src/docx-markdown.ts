import { chunkFeishuMarkdown, parseFeishuMarkdown, type FeishuMarkdownNode } from "./markdown.js";

export type DocxMarkdownImage = { url: string | undefined };

export type DocxMarkdownChunk = {
  markdown: string;
  images: DocxMarkdownImage[];
};

type DocxMarkdownPlan = {
  chunks: DocxMarkdownChunk[];
};

const MAX_BREAK_PROBES = 32;
const STABLE_LINE_CONTAINER_TYPES = new Set(["list", "blockquote", "code"]);

function visitMarkdown(root: FeishuMarkdownNode, visitor: (node: FeishuMarkdownNode) => void) {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) {
      continue;
    }
    visitor(node);
    if (!node.children) {
      continue;
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child) {
        pending.push(child);
      }
    }
  }
}

function resolveRemoteImageUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function collectMarkdownImages(root: FeishuMarkdownNode): DocxMarkdownImage[] {
  const definitions = new Map<string, string>();
  visitMarkdown(root, (node) => {
    if (node.type !== "definition" || !node.identifier || !node.url) {
      return;
    }
    // CommonMark resolves the first matching definition.
    if (!definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
  });

  const images: DocxMarkdownImage[] = [];
  visitMarkdown(root, (node) => {
    if (node.type === "image") {
      images.push({ url: resolveRemoteImageUrl(node.url) });
      return;
    }
    if (node.type === "imageReference") {
      images.push({
        url: resolveRemoteImageUrl(node.identifier ? definitions.get(node.identifier) : undefined),
      });
    }
  });
  return images;
}

function splitSourceAtOffsets(source: string, offsets: number[]): string[] {
  const chunks: string[] = [];
  let start = 0;
  for (const offset of offsets) {
    if (offset <= start || offset >= source.length) {
      continue;
    }
    chunks.push(source.slice(start, offset));
    start = offset;
  }
  chunks.push(source.slice(start));
  return chunks;
}

function headingOffsets(source: string, root: FeishuMarkdownNode): number[] {
  const offsets: number[] = [];
  for (const node of root.children ?? []) {
    if (node.type !== "heading" || node.depth === undefined || node.depth > 2) {
      continue;
    }
    const offset = node.position?.start.offset;
    // Preserve the existing ATX-only chunking contract; setext headings were
    // never request boundaries and may depend on nearby reference definitions.
    if (offset !== undefined && source[offset] === "#") {
      offsets.push(offset);
    }
  }
  return offsets;
}

function blockBreakOffsets(root: FeishuMarkdownNode): number[] {
  const offsets: number[] = [];
  for (const block of root.children ?? []) {
    const blockStart = block.position?.start.offset;
    if (blockStart !== undefined && blockStart > 0) {
      offsets.push(blockStart);
    }
  }
  return offsets;
}

function paragraphBreakOffsets(source: string, root: FeishuMarkdownNode): number[] {
  const offsets: number[] = [];
  for (const block of root.children ?? []) {
    if (block.type !== "paragraph") {
      continue;
    }
    for (const child of block.children ?? []) {
      if (child.type !== "text") {
        continue;
      }
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      if (start === undefined || end === undefined) {
        continue;
      }
      for (let offset = start; offset < end; offset += 1) {
        const char = source[offset];
        if (char === " " || char === "\t" || char === "\n" || char === "\r") {
          offsets.push(offset + 1);
        }
      }
    }
  }
  return offsets;
}

function lineBreakOffsets(source: string): number[] {
  const offsets: number[] = [];
  for (let offset = 0; offset < source.length; offset += 1) {
    if (source[offset] === "\n" && offset + 1 < source.length) {
      offsets.push(offset + 1);
    }
  }
  return offsets;
}

function nearestOffset(offsets: readonly number[], target: number, sourceLength: number) {
  return offsets
    .filter((offset) => offset > 0 && offset < sourceLength)
    .toSorted((left, right) => Math.abs(left - target) - Math.abs(right - target) || left - right);
}

function isStableParagraphBreak(source: string, offset: number): boolean {
  const before = parseFeishuMarkdown(source.slice(0, offset)).children?.at(-1);
  const after = parseFeishuMarkdown(source.slice(offset)).children?.[0];
  return before?.type === "paragraph" && after?.type === "paragraph";
}

function isStableContainerBreak(source: string, offset: number, containerType: string): boolean {
  const before = parseFeishuMarkdown(source.slice(0, offset)).children;
  const after = parseFeishuMarkdown(source.slice(offset)).children;
  return (
    before?.length === 1 &&
    after?.length === 1 &&
    before[0]?.type === containerType &&
    after[0]?.type === containerType
  );
}

function splitTableAtRow(
  source: string,
  root: FeishuMarkdownNode,
  target: number,
): string[] | undefined {
  const table = root.children?.length === 1 ? root.children[0] : undefined;
  if (table?.type !== "table") {
    return undefined;
  }
  const rows = table.children ?? [];
  const firstBodyOffset = rows[1]?.position?.start.offset;
  const splitOffset = nearestOffset(
    rows
      .slice(2)
      .map((row) => row.position?.start.offset)
      .filter((offset): offset is number => offset !== undefined),
    target,
    source.length,
  )[0];
  if (firstBodyOffset === undefined || splitOffset === undefined) {
    return undefined;
  }

  const tableStart = table.position?.start.offset ?? 0;
  const repeatedHeader = source.slice(tableStart, firstBodyOffset);
  const chunks = [source.slice(0, splitOffset), `${repeatedHeader}${source.slice(splitOffset)}`];
  if (chunks.every((chunk) => parseFeishuMarkdown(chunk).children?.[0]?.type === "table")) {
    return chunks;
  }
  return undefined;
}

function isFencedCodeSource(source: string): boolean {
  const firstLineEnd = source.indexOf("\n");
  const firstLine = source.slice(0, firstLineEnd === -1 ? source.length : firstLineEnd);
  let indent = 0;
  while (indent < firstLine.length && firstLine[indent] === " ") {
    indent += 1;
  }
  if (indent > 3) {
    return false;
  }
  const marker = firstLine.slice(indent);
  return marker.startsWith("```") || marker.startsWith("~~~");
}

export function createDocxMarkdownChunk(markdown: string): DocxMarkdownChunk {
  const root = parseFeishuMarkdown(markdown);
  return {
    markdown,
    images: collectMarkdownImages(root),
  };
}

export function createDocxMarkdownPlan(markdown: string): DocxMarkdownPlan {
  const root = parseFeishuMarkdown(markdown);
  return {
    // Feishu converts each request independently. Parse each exact chunk again
    // so cross-chunk reference definitions cannot shift later image block mapping.
    chunks: splitSourceAtOffsets(markdown, headingOffsets(markdown, root)).map(
      createDocxMarkdownChunk,
    ),
  };
}

export function splitDocxMarkdownBySize(markdown: string, maxChars: number): string[] {
  if (markdown.length <= maxChars) {
    return [markdown];
  }

  const root = parseFeishuMarkdown(markdown);
  const target = Math.min(markdown.length - 1, Math.max(1, maxChars));
  const splitOffset = nearestOffset(blockBreakOffsets(root), target, markdown.length)[0];
  if (splitOffset !== undefined) {
    return [markdown.slice(0, splitOffset), markdown.slice(splitOffset)];
  }

  // A direct text-node boundary is usable only when both independently parsed
  // halves remain paragraphs; otherwise a literal marker can become a new block.
  const paragraphOffset = nearestOffset(
    paragraphBreakOffsets(markdown, root),
    target,
    markdown.length,
  )
    // Keep reparsing bounded for hostile, whitespace-heavy input.
    .slice(0, MAX_BREAK_PROBES)
    .find((offset) => isStableParagraphBreak(markdown, offset));
  if (paragraphOffset !== undefined) {
    return [markdown.slice(0, paragraphOffset), markdown.slice(paragraphOffset)];
  }

  // Fence balancing is semantics-preserving only for one fenced code node.
  if (
    root.children?.length === 1 &&
    root.children[0]?.type === "code" &&
    isFencedCodeSource(markdown)
  ) {
    return chunkFeishuMarkdown(markdown, maxChars);
  }

  const tableChunks = splitTableAtRow(markdown, root, target);
  if (tableChunks) {
    return tableChunks;
  }

  const containerType = root.children?.length === 1 ? root.children[0]?.type : undefined;
  if (containerType && STABLE_LINE_CONTAINER_TYPES.has(containerType)) {
    const containerOffset = nearestOffset(lineBreakOffsets(markdown), target, markdown.length)
      .slice(0, MAX_BREAK_PROBES)
      .find((offset) => isStableContainerBreak(markdown, offset, containerType));
    if (containerOffset !== undefined) {
      return [markdown.slice(0, containerOffset), markdown.slice(containerOffset)];
    }
  }
  return [markdown];
}
