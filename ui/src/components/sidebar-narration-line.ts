import { clampText } from "../lib/format.ts";

const SIDEBAR_NARRATION_MAX_LENGTH = 120;

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compact the newest prose into one quiet, stable sidebar line. */
export function deriveSidebarNarrationLine(text: string): string {
  const paragraphs = text
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\n\s*\n/)
    .map((paragraph) => stripMarkdown(paragraph))
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
