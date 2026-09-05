import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { clampText } from "../lib/format.ts";

const SIDEBAR_NARRATION_MAX_LENGTH = 120;

/** Compact the newest prose into one quiet, stable sidebar line. */
export function deriveSidebarNarrationLine(text: string): string {
  // Fences are dropped before the paragraph split, not just by the shared
  // flattener: a fenced block contains blank lines, so splitting first would
  // let code fragments become the "newest paragraph" and win the line.
  const paragraphs = text
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\n\s*\n/)
    .map((paragraph) => flattenMarkdownToPlainText(paragraph))
    .filter(Boolean);
  const paragraph = paragraphs.at(-1) ?? "";
  if (!paragraph) {
    return "";
  }
  const fragments = paragraph.match(/[^.!?…]+(?:[.!?…]+(?=\s|$)|$)/g);
  const newest =
    fragments?.map((fragment) => fragment.trim()).findLast((fragment) => Boolean(fragment)) ??
    paragraph;
  return clampText(newest, SIDEBAR_NARRATION_MAX_LENGTH);
}
