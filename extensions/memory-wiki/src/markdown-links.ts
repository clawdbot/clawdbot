import path from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";

export const WIKI_RELATED_START_MARKER = "<!-- openclaw:wiki:related:start -->";
export const WIKI_RELATED_END_MARKER = "<!-- openclaw:wiki:related:end -->";

const OBSIDIAN_LINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\(([^)]+)\)/g;
const RELATED_BLOCK_PATTERN = new RegExp(
  `${WIKI_RELATED_START_MARKER}[\\s\\S]*?${WIKI_RELATED_END_MARKER}`,
  "g",
);

function normalizeMarkdownLinkTarget(sourceRelativePath: string, target: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(sourceRelativePath), target));
}

type MarkdownAstNode = {
  type?: string;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
  children?: MarkdownAstNode[];
};

function maskMarkdownCode(markdown: string): string {
  const masked = markdown.split("");
  const visit = (node: MarkdownAstNode): void => {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (start !== undefined && end !== undefined) {
        for (let index = start; index < end; index++) {
          if (masked[index] !== "\n" && masked[index] !== "\r") {
            masked[index] = " ";
          }
        }
      }
      return;
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(fromMarkdown(markdown));
  return masked.join("");
}

export function extractWikiLinks(markdown: string, sourceRelativePath: string): string[] {
  // Masking cannot add brackets, and both supported link forms require one.
  if (!markdown.includes("[")) {
    return [];
  }
  const withoutRelatedBlock = markdown.replace(RELATED_BLOCK_PATTERN, "");
  const searchable = maskMarkdownCode(withoutRelatedBlock);
  const links: string[] = [];
  for (const match of searchable.matchAll(OBSIDIAN_LINK_PATTERN)) {
    const target = match[1]?.trim();
    if (target) {
      links.push(target);
    }
  }
  for (const match of searchable.matchAll(MARKDOWN_LINK_PATTERN)) {
    const rawTarget = match[1]?.trim();
    if (!rawTarget || rawTarget.startsWith("#") || /^[a-z]+:/i.test(rawTarget)) {
      continue;
    }
    const target = rawTarget.split("#")[0]?.split("?")[0]?.replace(/\\/g, "/").trim();
    if (target) {
      links.push(normalizeMarkdownLinkTarget(sourceRelativePath, target));
    }
  }
  return links;
}
