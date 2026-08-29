import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { parseConfigPathArrayIndex } from "./path-array-index.js";

export type ConcreteConfigPathSegment = string | number;
export type ParsedConcreteConfigPath = {
  tokens: ConcreteConfigPathSegment[];
  quotedNumericSegments: ReadonlySet<number>;
};

function parseQuotedBracketPathSegment(value: string): unknown {
  const quote = value.startsWith('"') ? '"' : "'";
  if (quote === '"') {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      // Quoted config paths also accept the JSON5 string escapes used by shipped CLI paths.
    }
  }
  if (!value.endsWith(quote)) {
    throw new SyntaxError("Unterminated quoted path segment");
  }

  let normalized = '"';
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    if (character === quote) {
      throw new SyntaxError("Unexpected quote in path segment");
    }
    if (character === '"') {
      normalized += '\\"';
      continue;
    }
    if (character === "\\") {
      const escaped = value[index + 1];
      if (escaped === undefined || index + 1 >= value.length - 1) {
        throw new SyntaxError("Unterminated escape in path segment");
      }
      index += 1;
      if (escaped === "\n" || escaped === "\u2028" || escaped === "\u2029") {
        continue;
      }
      if (escaped === "\r") {
        if (value[index + 1] === "\n") {
          index += 1;
        }
        continue;
      }
      if (escaped === "x") {
        const hex = value.slice(index + 1, index + 3);
        if (!/^[\da-f]{2}$/i.test(hex)) {
          throw new SyntaxError("Invalid hexadecimal escape in path segment");
        }
        normalized += `\\u00${hex}`;
        index += 2;
        continue;
      }
      if (escaped === "0") {
        if (/\d/.test(value[index + 1] ?? "")) {
          throw new SyntaxError("Invalid numeric escape in path segment");
        }
        normalized += "\\u0000";
        continue;
      }
      if (escaped === "v") {
        normalized += "\\u000b";
        continue;
      }
      if (/[1-9]/.test(escaped)) {
        throw new SyntaxError("Invalid numeric escape in path segment");
      }
      if (escaped === "'") {
        normalized += "'";
      } else if ('"\\/bfnrtu'.includes(escaped)) {
        normalized += `\\${escaped}`;
      } else {
        normalized += escaped;
      }
      continue;
    }
    normalized += character;
  }
  return JSON.parse(`${normalized}"`) as unknown;
}

function parseBracketPathSegment(raw: string, fullPath: string): ConcreteConfigPathSegment {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`Invalid path (empty "[]"): ${fullPath}`);
  }
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    try {
      const parsed = parseQuotedBracketPathSegment(trimmed);
      if (typeof parsed === "string" && parsed.trim()) {
        return parsed;
      }
    } catch (err) {
      throw new Error(`Invalid path bracket string (${trimmed}): ${fullPath}`, { cause: err });
    }
    throw new Error(`Invalid path bracket string (${trimmed}): ${fullPath}`);
  }
  return parseConfigPathArrayIndex(trimmed) ?? trimmed;
}

function assertNotWhitespaceSegment(current: string, raw: string): void {
  if (current.length > 0 && !current.trim()) {
    throw new Error(`Invalid path (empty segment): ${raw}`);
  }
}

function findBracketPathClose(path: string, open: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = open + 1; index < path.length; index += 1) {
    const character = path[index];
    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "]") {
      return index;
    }
    if ((character === '"' || character === "'") && !path.slice(open + 1, index).trim()) {
      quote = character;
    }
  }
  return -1;
}

/** Retains quoted numeric-key provenance alongside the public concrete path tokens. */
export function parseConcreteConfigPathWithProvenance(raw: string): ParsedConcreteConfigPath {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Path is empty.");
  }
  const parts: ConcreteConfigPathSegment[] = [];
  const quotedNumericSegments = new Set<number>();
  let current = "";
  let segmentEmitted = false;
  let index = 0;
  while (index < trimmed.length) {
    const character = trimmed[index];
    if (character === "\\") {
      const next = trimmed[index + 1];
      if (next === undefined) {
        throw new Error(`Invalid path (trailing escape): ${raw}`);
      }
      current += next;
      index += 2;
      continue;
    }
    if (character === ".") {
      assertNotWhitespaceSegment(current, raw);
      if (!segmentEmitted && !current.trim()) {
        throw new Error(`Invalid path (empty segment): ${raw}`);
      }
      if (current) {
        parts.push(current.trim());
      }
      current = "";
      segmentEmitted = false;
      index += 1;
      continue;
    }
    if (character === "[") {
      assertNotWhitespaceSegment(current, raw);
      if (!current.trim() && !segmentEmitted && parts.length > 0) {
        throw new Error(`Invalid path (empty segment): ${raw}`);
      }
      if (current) {
        parts.push(current.trim());
      }
      current = "";
      const close = findBracketPathClose(trimmed, index);
      if (close === -1) {
        throw new Error(`Invalid path (missing "]"): ${raw}`);
      }
      const inside = trimmed.slice(index + 1, close).trim();
      if (!inside) {
        throw new Error(`Invalid path (empty "[]"): ${raw}`);
      }
      const segment = parseBracketPathSegment(inside, raw);
      if (
        typeof segment === "string" &&
        (inside.startsWith('"') || inside.startsWith("'")) &&
        parseConfigPathArrayIndex(segment) !== undefined
      ) {
        quotedNumericSegments.add(parts.length);
      }
      parts.push(segment);
      const next = trimmed[close + 1];
      if (next !== undefined && next !== "." && next !== "[") {
        throw new Error(`Invalid path (missing separator after bracket): ${raw}`);
      }
      segmentEmitted = true;
      index = close + 1;
      continue;
    }
    current += character;
    index += 1;
  }
  if (!segmentEmitted && !current.trim()) {
    throw new Error(`Invalid path (empty segment): ${raw}`);
  }
  if (current) {
    parts.push(current.trim());
  }
  for (const segment of parts) {
    if (typeof segment === "string" && isBlockedObjectKey(segment)) {
      throw new Error(`Invalid path segment: ${segment}`);
    }
  }
  return { tokens: parts, quotedNumericSegments };
}

/** Parses one concrete path while keeping explicit array brackets distinct from quoted keys. */
export function parseConcreteConfigPathTokens(raw: string): ConcreteConfigPathSegment[] {
  return parseConcreteConfigPathWithProvenance(raw).tokens;
}

/** Parses one concrete config path into the existing string-segment CLI contract. */
export function parseConcreteConfigPath(raw: string): string[] {
  return parseConcreteConfigPathTokens(raw).map(String);
}

/** Appends one config path segment without confusing literal record keys with traversal. */
export function appendConfigPathSegment(path: string, segment: string | number): string {
  if (typeof segment === "number") {
    return `${path}[${segment}]`;
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$:-]*$/.test(segment)) {
    return `${path}[${JSON.stringify(segment)}]`;
  }
  return path ? `${path}.${segment}` : segment;
}

/** Formats concrete tokens, recovering array indices from their actual source containers. */
export function formatConcreteConfigPath(
  segments: readonly ConcreteConfigPathSegment[],
  source?: unknown,
): string {
  let cursor = source;
  return segments.reduce<string>((path, segment) => {
    const concreteSegment =
      typeof segment === "string" && Array.isArray(cursor)
        ? (parseConfigPathArrayIndex(segment) ?? segment)
        : segment;
    cursor =
      cursor !== null && typeof cursor === "object"
        ? Reflect.get(cursor, String(segment))
        : undefined;
    return appendConfigPathSegment(path, concreteSegment);
  }, "");
}

/** Joins path segments into their dotted-path representation. */
export function toDotPath(segments: readonly string[]): string {
  return segments.join(".");
}
