// Output extractors for media-understanding provider CLI responses.

/** Parse the last JSON object in a noisy provider output string. */
function extractLastJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const ranges: Array<{ end: number; start: number }> = [];
  const starts: number[] = [];
  let inString = false;
  let escaped = false;
  let preambleQuote: string | undefined;
  let preambleEscaped = false;
  let previousSignificant: string | undefined;
  let lineHasNonWhitespace = false;
  let arrayDepth = 0;
  let candidateHasContent = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed.charAt(index);
    if (inString) {
      if (character === "\n" || character === "\r") {
        starts.length = 0;
        inString = false;
        escaped = false;
      } else if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (starts.length === 0) {
      if (preambleQuote !== undefined) {
        if (character === "\n" || character === "\r") {
          preambleQuote = undefined;
          preambleEscaped = false;
        } else if (preambleEscaped) {
          preambleEscaped = false;
        } else if (character === "\\") {
          preambleEscaped = true;
        } else if (character === preambleQuote) {
          preambleQuote = undefined;
        }
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        const previous = trimmed[index - 1];
        if (previous === undefined || /[\s:([{]/.test(previous)) {
          preambleQuote = character;
          preambleEscaped = false;
          continue;
        }
      }
      if (character === "{") {
        arrayDepth = 0;
        candidateHasContent = false;
        starts.push(index);
      }
      if (!/\s/.test(character)) {
        previousSignificant = character;
        lineHasNonWhitespace = true;
      } else if (character === "\n" || character === "\r") {
        lineHasNonWhitespace = false;
      }
      continue;
    }

    const hadCandidateContent = candidateHasContent;
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      if (
        previousSignificant === ":" ||
        previousSignificant === "[" ||
        previousSignificant === '"' ||
        (previousSignificant === "," && (lineHasNonWhitespace || arrayDepth > 0))
      ) {
        starts.push(index);
      } else if (!lineHasNonWhitespace && !hadCandidateContent) {
        // Only resync at a clean record boundary; otherwise keep malformed
        // outer objects from promoting diagnostic payloads as valid results.
        starts.length = 1;
        starts[0] = index;
        arrayDepth = 0;
        candidateHasContent = false;
      }
    } else if (character === "}" && starts.length > 0) {
      const start = starts.pop();
      if (start !== undefined && starts.length === 0) {
        ranges.push({ start, end: index });
      }
    } else if (character === "[") {
      arrayDepth += 1;
    } else if (character === "]" && arrayDepth > 0) {
      arrayDepth -= 1;
    }

    if (!/\s/.test(character)) {
      candidateHasContent = true;
      previousSignificant = character;
      lineHasNonWhitespace = true;
    } else if (character === "\n" || character === "\r") {
      lineHasNonWhitespace = false;
    }
  }

  for (const range of ranges.toReversed()) {
    try {
      return JSON.parse(trimmed.slice(range.start, range.end + 1));
    } catch {
      // Ignore malformed objects and try the previous completed range.
    }
  }

  return null;
}

/** Extract Gemini CLI-style response text from the last JSON object in output. */
export function extractGeminiResponse(raw: string): string | null {
  const payload = extractLastJsonObject(raw);
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const response = (payload as { response?: unknown }).response;
  if (typeof response !== "string") {
    return null;
  }
  const trimmed = response.trim();
  return trimmed || null;
}
