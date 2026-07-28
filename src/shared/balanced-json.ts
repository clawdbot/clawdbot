/** JSON opening delimiters supported by the balanced-fragment scanner. */
type JsonOpeningDelimiter = "{" | "[";

/** One balanced JSON object/array fragment found inside arbitrary text. */
type BalancedJsonFragment = {
  json: string;
  startIndex: number;
  endIndex: number;
};

const CLOSING_DELIMITER: Record<JsonOpeningDelimiter, "}" | "]"> = {
  "{": "}",
  "[": "]",
};

function isJsonOpeningDelimiter(
  char: string | undefined,
  openers: readonly JsonOpeningDelimiter[],
): char is JsonOpeningDelimiter {
  return char === "{" ? openers.includes("{") : char === "[" && openers.includes("[");
}

/** Extract the first balanced JSON object/array prefix found in text. */
export function extractBalancedJsonPrefix(
  raw: string,
  opts: { openers?: readonly JsonOpeningDelimiter[] } = {},
): BalancedJsonFragment | null {
  const openers = opts.openers ?? (["{", "["] as const);
  let start = 0;
  while (start < raw.length && !isJsonOpeningDelimiter(raw[start], openers)) {
    start += 1;
  }
  if (start >= raw.length) {
    return null;
  }

  const stack: JsonOpeningDelimiter[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];
    if (inString) {
      // Delimiters inside strings are data, not structure. Track escapes so an
      // escaped quote does not prematurely end string mode.
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (isJsonOpeningDelimiter(char, openers)) {
      stack.push(char);
      continue;
    }
    const opener = stack.at(-1);
    if (opener && char === CLOSING_DELIMITER[opener]) {
      stack.pop();
      if (stack.length === 0) {
        return { json: raw.slice(start, i + 1), startIndex: start, endIndex: i };
      }
    }
  }
  return null;
}

/** Extract every balanced JSON object/array fragment from arbitrary text. */
export function extractBalancedJsonFragments(
  raw: string,
  opts: { openers?: readonly JsonOpeningDelimiter[] } = {},
): BalancedJsonFragment[] {
  const fragments: BalancedJsonFragment[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const fragment = extractBalancedJsonPrefix(raw.slice(offset), opts);
    if (!fragment) {
      break;
    }
    fragments.push({
      json: fragment.json,
      startIndex: offset + fragment.startIndex,
      endIndex: offset + fragment.endIndex,
    });
    offset += fragment.endIndex + 1;
  }
  return fragments;
}
