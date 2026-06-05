// JSON parse helpers recover structured values from partial model output.
import { parse as partialParse } from "partial-json";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
const JSON_CONTROL_ESCAPES = new Set(["b", "f", "n", "r", "t"]);

function isControlCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
  switch (char) {
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
  }
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 */
export function repairJson(json: string): string {
  let repaired = "";
  let inString = false;
  let stringValuePrefix = "";

  for (let index = 0; index < json.length; index++) {
    const char = json[index];

    if (!inString) {
      repaired += char;
      if (char === '"') {
        inString = true;
        stringValuePrefix = "";
      }
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = false;
      stringValuePrefix = "";
      continue;
    }

    if (char === "\\") {
      const nextChar = json[index + 1];
      if (nextChar === undefined) {
        repaired += "\\\\";
        continue;
      }

      if (nextChar === "u") {
        const unicodeDigits = json.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
          repaired += `\\u${unicodeDigits}`;
          stringValuePrefix += `\\u${unicodeDigits}`;
          index += 5;
          continue;
        }
        // A \u not followed by four hex digits is an invalid escape: double the
        // backslash like the other invalid escapes below. Falling through would
        // hit the valid-escape branch (VALID_JSON_ESCAPES contains "u") and
        // re-emit the broken \u, leaving the JSON unparseable.
        repaired += "\\\\";
        stringValuePrefix += "\\";
        continue;
      }

      if (JSON_CONTROL_ESCAPES.has(nextChar) && looksLikeWindowsPathPrefix(stringValuePrefix)) {
        repaired += "\\\\";
        stringValuePrefix += "\\";
        continue;
      }

      if (VALID_JSON_ESCAPES.has(nextChar)) {
        repaired += `\\${nextChar}`;
        stringValuePrefix += nextChar === "\\" ? "\\" : `\\${nextChar}`;
        index += 1;
        continue;
      }

      repaired += "\\\\";
      stringValuePrefix += "\\";
      continue;
    }

    repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
    stringValuePrefix += char;
  }

  return repaired;
}

export function parseJsonWithRepair(json: string): unknown {
  const repairedJson = repairJson(json);
  if (repairedJson !== json) {
    return JSON.parse(repairedJson) as unknown;
  }
  return JSON.parse(json) as unknown;
}

function looksLikeWindowsPathPrefix(prefix: string): boolean {
  const tail = prefix.slice(-160);
  return /(?:^|[^A-Za-z0-9])[A-Za-z]:(?:[\\/][^"\\/:*?<>|\r\n]*)*$/.test(tail);
}

function asStreamingJsonRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson(partialJson: string | undefined): Record<string, unknown> {
  if (!partialJson || partialJson.trim() === "") {
    return {};
  }

  try {
    return asStreamingJsonRecord(parseJsonWithRepair(partialJson));
  } catch {
    try {
      const result = partialParse(partialJson);
      return asStreamingJsonRecord(result);
    } catch {
      try {
        const result = partialParse(repairJson(partialJson));
        return asStreamingJsonRecord(result);
      } catch {
        return {};
      }
    }
  }
}
