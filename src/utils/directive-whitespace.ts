import { expectDefined } from "@openclaw/normalization-core";
import { parseFenceSpans } from "../../packages/markdown-core/src/fences.js";

const BLOCK_SENTINEL_SEED = "\uE000";

function createBlockSentinel(text: string): string {
  let sentinel = BLOCK_SENTINEL_SEED;
  while (text.includes(sentinel)) {
    sentinel += BLOCK_SENTINEL_SEED;
  }
  return sentinel;
}

export function normalizeDirectiveWhitespace(text: string): string {
  // Extract -> normalize prose -> restore:
  // Stash every code block (fenced ``` / ~~~ and indent-code 4-space/tab)
  // under a sentinel-delimited placeholder so the prose regexes never touch them.
  const blockSentinel = createBlockSentinel(text);
  const blockPlaceholderRe = new RegExp(`${blockSentinel}(\\d+)${blockSentinel}`, "g");
  const blocks: string[] = [];
  const fenceSpans = text.includes("```") || text.includes("~~~") ? parseFenceSpans(text) : [];
  let masked = "";
  let cursor = 0;
  // The canonical scanner keeps false closers, indented closers, and open fences intact.
  for (const span of fenceSpans) {
    blocks.push(text.slice(span.start, span.end));
    masked += `${text.slice(cursor, span.start)}${blockSentinel}${blocks.length - 1}${blockSentinel}`;
    cursor = span.end;
  }
  masked = `${masked}${text.slice(cursor)}`.replace(
    /(?:(?:^|\n)(?:    |\t)[^\n]*)(?:\n(?:[ \t]*\n)*(?:    |\t)[^\n]*)*/gm,
    (block) => {
      blocks.push(block);
      return `${blockSentinel}${blocks.length - 1}${blockSentinel}`;
    },
  );

  const normalized = masked
    .replace(/\r\n/g, "\n")
    .replace(/([^\s])[ \t]{2,}([^\s])/g, "$1 $2")
    .replace(/^\n+/, "")
    .replace(/^[ \t](?=\S)/, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();

  return normalized.replace(blockPlaceholderRe, (_, i) =>
    expectDefined(blocks[Number(i)], "blocks entry at number(i)"),
  );
}
