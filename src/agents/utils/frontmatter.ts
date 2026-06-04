/**
 * YAML frontmatter parsing helpers.
 *
 * Agent docs/tools use this to split optional Markdown frontmatter from the
 * body while preserving normal content when no complete frontmatter fence exists.
 */
import { parse } from "yaml";

/** Parsed frontmatter metadata plus the remaining document body. */
type ParsedFrontmatter<T extends Record<string, unknown>> = {
  frontmatter: T;
  body: string;
};

const normalizeNewlines = (value: string): string =>
  value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const extractFrontmatter = (content: string): { yamlString: string | null; body: string } => {
  const normalized = normalizeNewlines(content);

  if (!normalized.startsWith("---")) {
    return { yamlString: null, body: normalized };
  }

  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { yamlString: null, body: normalized };
  }

  return {
    yamlString: normalized.slice(4, endIndex),
    body: normalized.slice(endIndex + 4).trim(),
  };
};

/** Parses optional YAML frontmatter from Markdown-like content. */
export const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
  content: string,
): ParsedFrontmatter<T> => {
  const { yamlString, body } = extractFrontmatter(content);
  if (!yamlString) {
    return { frontmatter: {} as T, body };
  }
  const parsed = parse(yamlString);
  return { frontmatter: (parsed ?? {}) as T, body };
};

/** Removes YAML frontmatter from content when a complete frontmatter block exists. */
export const stripFrontmatter = (content: string): string => parseFrontmatter(content).body;
