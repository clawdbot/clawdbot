import YAML from "yaml";

export type ParsedFrontmatter = Record<string, string>;

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function coerceFrontmatterValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseYamlFrontmatter(block: string): ParsedFrontmatter | null {
  try {
    const parsed = YAML.parse(block) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const result: ParsedFrontmatter = {};
    for (const [rawKey, value] of Object.entries(parsed as Record<string, unknown>)) {
      const key = rawKey.trim();
      if (!key) continue;
      const coerced = coerceFrontmatterValue(value);
      if (coerced === undefined) continue;
      result[key] = coerced;
    }
    return result;
  } catch {
    return null;
  }
}

function extractMultiLineValue(
  lines: string[],
  startIndex: number,
): { value: string; linesConsumed: number } {
  const startLine = lines[startIndex];
  const match = startLine.match(/^([\w-]+):\s*(.*)$/);
  if (!match) return { value: "", linesConsumed: 1 };

  const inlineValue = match[2].trim();
  if (inlineValue) {
    return { value: inlineValue, linesConsumed: 1 };
  }

  const valueLines: string[] = [];
  let i = startIndex + 1;

  while (i < lines.length) {
    const line = lines[i];
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) {
      break;
    }
    valueLines.push(line);
    i++;
  }

  const combined = valueLines.join("\n").trim();
  return { value: combined, linesConsumed: i - startIndex };
}

function parseLineFrontmatter(block: string): ParsedFrontmatter {
  const frontmatter: ParsedFrontmatter = {};
  const lines = block.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (!match) {
      i++;
      continue;
    }

    const key = match[1];
    const inlineValue = match[2].trim();

    if (!key) {
      i++;
      continue;
    }

    if (!inlineValue && i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      if (nextLine.startsWith(" ") || nextLine.startsWith("\t")) {
        const { value, linesConsumed } = extractMultiLineValue(lines, i);
        if (value) {
          frontmatter[key] = value;
        }
        i += linesConsumed;
        continue;
      }
    }

    const value = stripQuotes(inlineValue);
    if (value) {
      frontmatter[key] = value;
    }
    i++;
  }

  return frontmatter;
}

export function parseFrontmatterBlock(content: string): ParsedFrontmatter {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return {};
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return {};
  const block = normalized.slice(4, endIndex);

  const lineParsed = parseLineFrontmatter(block);
  const yamlParsed = parseYamlFrontmatter(block);
  if (yamlParsed === null) return lineParsed;

  const merged: ParsedFrontmatter = { ...yamlParsed };
  for (const [key, value] of Object.entries(lineParsed)) {
    if (value.startsWith("{") || value.startsWith("[")) {
      merged[key] = value;
    }
  }
  return merged;
}
