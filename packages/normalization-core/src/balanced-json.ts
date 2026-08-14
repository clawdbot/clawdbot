type JsonOpeningDelimiter = "{" | "[";

type BalancedJsonFragment = {
  json: string;
  startIndex: number;
  endIndex: number;
};

function isJsonOpeningDelimiter(
  char: string | undefined,
  openers: readonly JsonOpeningDelimiter[],
): char is JsonOpeningDelimiter {
  return (char === "{" || char === "[") && openers.includes(char);
}

function findLiteralOpeningDelimiter(
  raw: string,
  fromIndex: number,
  openers: readonly JsonOpeningDelimiter[],
): number {
  let index = fromIndex;
  while (index < raw.length && !isJsonOpeningDelimiter(raw[index], openers)) {
    index += 1;
  }
  return index;
}

function extractBalancedFrom(
  raw: string,
  start: number,
  openers: readonly JsonOpeningDelimiter[],
): BalancedJsonFragment | null {
  const stack: JsonOpeningDelimiter[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (isJsonOpeningDelimiter(char, openers)) {
      stack.push(char);
    } else if (stack.length > 0 && char === (stack.at(-1) === "{" ? "}" : "]")) {
      stack.pop();
      if (stack.length === 0) {
        return { json: raw.slice(start, index + 1), startIndex: start, endIndex: index };
      }
    }
  }
  return null;
}

/** Extracts the first balanced JSON object/array from text. */
export function extractBalancedJsonPrefix(
  raw: string,
  opts: { openers?: readonly JsonOpeningDelimiter[] } = {},
): BalancedJsonFragment | null {
  const openers = opts.openers ?? (["{", "["] as const);

  // Quoted prose before the JSON value is not itself JSON, so a delimiter
  // inside a complete quoted span must not be mistaken for the real start.
  let inString = false;
  let escaped = false;
  let openQuoteIndex = -1;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
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
      openQuoteIndex = index;
      continue;
    }
    if (isJsonOpeningDelimiter(char, openers)) {
      return extractBalancedFrom(raw, index, openers);
    }
  }
  if (!inString) {
    return null;
  }

  // A quote still open at end-of-input is malformed input rather than prose.
  // Its own span was never confirmed as quoted text, so a literal scan inside
  // it is safe; completed quoted spans before it stay permanently skipped,
  // even when that means extracting no fragment at all.
  const literalStart = findLiteralOpeningDelimiter(raw, openQuoteIndex, openers);
  return literalStart < raw.length ? extractBalancedFrom(raw, literalStart, openers) : null;
}

/** Extracts every balanced JSON object/array fragment from arbitrary text. */
export function extractBalancedJsonFragments(
  raw: string,
  opts: { openers?: readonly JsonOpeningDelimiter[] } = {},
): BalancedJsonFragment[] {
  const fragments: BalancedJsonFragment[] = [];
  for (let offset = 0; offset < raw.length;) {
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
