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

// Quoted prose before the JSON value is not itself JSON, so a delimiter
// inside a complete quoted span must not be mistaken for the real start. An
// unterminated quote can't reliably be told apart from real prose, so when
// one is still open at end-of-input, this retries a literal (quote-blind)
// scan from each quote-opening checkpoint, most recent first, stopping at
// the first one that recovers a delimiter. This falls back only as far as
// necessary instead of resurrecting a delimiter from an earlier span that
// was already validly paired and skipped.
function findStart(raw: string, openers: readonly JsonOpeningDelimiter[]): number {
  let inString = false;
  let escaped = false;
  const openQuoteCheckpoints: number[] = [];
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
      openQuoteCheckpoints.push(index);
      continue;
    }
    if (isJsonOpeningDelimiter(char, openers)) {
      return index;
    }
  }
  if (!inString) {
    return raw.length;
  }
  for (let i = openQuoteCheckpoints.length - 1; i >= 0; i -= 1) {
    const checkpoint = openQuoteCheckpoints[i];
    if (checkpoint === undefined) {
      continue;
    }
    const candidate = findLiteralOpeningDelimiter(raw, checkpoint, openers);
    if (candidate < raw.length) {
      return candidate;
    }
  }
  return raw.length;
}

/** Extracts the first balanced JSON object/array from text. */
export function extractBalancedJsonPrefix(
  raw: string,
  opts: { openers?: readonly JsonOpeningDelimiter[] } = {},
): BalancedJsonFragment | null {
  const openers = opts.openers ?? (["{", "["] as const);
  const start = findStart(raw, openers);
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
