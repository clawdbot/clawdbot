// Markdown Core module implements frontmatter behavior.
import { isMap, isNode, parseDocument } from "yaml";

type ParsedFrontmatter = Record<string, string>;

type ParsedYamlValue = {
  value: string;
  kind: "scalar" | "structured";
};

function stripQuotes(value: string): string {
  const quote = value.at(0);
  return (quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value;
}

function coerceYamlFrontmatterValue(value: unknown): ParsedYamlValue | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return { value: value.trim(), kind: "scalar" };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { value: String(value), kind: "scalar" };
  }
  if (typeof value === "object") {
    try {
      return { value: JSON.stringify(value), kind: "structured" };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseLineFrontmatter(block: string): ParsedFrontmatter {
  const result: ParsedFrontmatter = {};
  const lines = block.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines.at(i)?.match(/^([\w-]+):\s*(.*)$/);
    const key = match?.[1];
    const rawValue = match?.[2];
    if (!key || rawValue === undefined) {
      continue;
    }

    let value = rawValue.trim();
    if (!value && /^[ \t]/.test(lines.at(i + 1) ?? "")) {
      const valueLines: string[] = [];
      while (i + 1 < lines.length) {
        const line = lines.at(i + 1);
        if (line === undefined || (line && !/^[ \t]/.test(line))) {
          break;
        }
        valueLines.push(line);
        i += 1;
      }
      value = valueLines.join("\n").trim();
    } else {
      value = stripQuotes(value);
    }

    if (value) {
      result[key] = value;
    }
  }

  return result;
}

function parseYamlFrontmatter(block: string): ParsedFrontmatter {
  const fallback = parseLineFrontmatter(block);
  try {
    const doc = parseDocument(block, { schema: "core", prettyErrors: false });
    if (doc.errors.length > 0 || !isMap(doc.contents)) {
      return fallback;
    }

    const parsed = doc.toJS() as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fallback;
    }

    const inlineColonKeys = new Set<string>();
    for (const pair of doc.contents.items) {
      if (!isNode(pair.key)) {
        continue;
      }
      const start = pair.key.range?.[0];
      if (start === undefined) {
        continue;
      }
      const lineEnd = block.indexOf("\n", start);
      const line = block.slice(start, lineEnd === -1 ? block.length : lineEnd);
      const match = line.match(/^([\w-]+):\s*(.*)$/);
      if (match?.[1] && match[2]?.includes(":")) {
        inlineColonKeys.add(match[1]);
      }
    }

    const result: ParsedFrontmatter = {};
    for (const [rawKey, value] of Object.entries(parsed as Record<string, unknown>)) {
      const key = rawKey.trim();
      const coerced = key ? coerceYamlFrontmatterValue(value) : undefined;
      if (!coerced) {
        continue;
      }
      const fallbackValue = Object.hasOwn(fallback, key) ? fallback[key] : undefined;
      result[key] =
        coerced.kind === "structured" && inlineColonKeys.has(key) && fallbackValue !== undefined
          ? fallbackValue
          : coerced.value;
    }

    for (const [key, value] of Object.entries(fallback)) {
      if (!Object.hasOwn(result, key)) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return fallback;
  }
}

export type ExtractedFrontmatterBlock = {
  block: string;
  body: string;
};

function normalizeFrontmatterContent(content: string): string {
  return content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

const FRONTMATTER_CLOSING_DELIMITER = /(?:^|\n)---[^\S\n]*(?:\n|(?![\s\S]))/;

function extractFrontmatterBlockFromNormalized(
  normalized: string,
): ExtractedFrontmatterBlock | undefined {
  const opening = /^---[^\S\n]*\n/.exec(normalized);
  if (!opening) {
    return undefined;
  }
  const blockStart = opening[0].length;
  const tail = normalized.slice(blockStart);
  const closing = FRONTMATTER_CLOSING_DELIMITER.exec(tail);
  if (!closing) {
    return undefined;
  }
  return {
    block: tail.slice(0, closing.index),
    body: tail.slice(closing.index + closing[0].length),
  };
}

/** Splits a complete leading YAML frontmatter block from its Markdown body. */
export function extractFrontmatterBlock(content: string): ExtractedFrontmatterBlock | undefined {
  const normalized = normalizeFrontmatterContent(content);
  return extractFrontmatterBlockFromNormalized(normalized);
}

/** Removes a leading YAML frontmatter block and returns the remaining Markdown body. */
export function stripFrontmatterBlock(content: string): string {
  const normalized = normalizeFrontmatterContent(content);
  return (extractFrontmatterBlockFromNormalized(normalized)?.body ?? normalized).trim();
}

/** Parses leading YAML frontmatter into string values used by skill and metadata loaders. */
export function parseFrontmatterBlock(content: string): ParsedFrontmatter {
  const block = extractFrontmatterBlock(content)?.block;
  return block ? parseYamlFrontmatter(block) : {};
}
