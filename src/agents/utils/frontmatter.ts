/**
 * YAML frontmatter parsing helpers.
 *
 * Agent docs/tools use this to split optional Markdown frontmatter from the
 * body while preserving normal content when no complete frontmatter fence exists.
 */
import { parse } from "yaml";
import { extractFrontmatterBlock } from "../../../packages/markdown-core/src/frontmatter.js";

/** Parsed frontmatter metadata plus the remaining document body. */
type ParsedFrontmatter<T extends Record<string, unknown>> = {
  frontmatter: T;
  body: string;
};

const normalizeNewlines = (value: string): string =>
  value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

/** Parses optional YAML frontmatter from Markdown-like content. */
export const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
  content: string,
): ParsedFrontmatter<T> => {
  const normalized = normalizeNewlines(content);
  const extracted = extractFrontmatterBlock(normalized);
  if (!extracted) {
    return { frontmatter: {} as T, body: normalized };
  }
  const parsed = parse(extracted.block);
  return { frontmatter: (parsed ?? {}) as T, body: extracted.body.trim() };
};

/** Removes YAML frontmatter from content when a complete frontmatter block exists. */
export const stripFrontmatter = (content: string): string => parseFrontmatter(content).body;
