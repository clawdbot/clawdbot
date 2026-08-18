/** Estimates decoded bytes without allocating a cleaned copy of the base64 payload. */
export function estimateBase64DecodedBytes(base64: string): number {
  // Avoid `trim()`/`replace()` here: they allocate a second (potentially huge) string.
  // We only need a conservative decoded-size estimate to enforce budgets before Buffer.from(..., "base64").
  let effectiveLen = 0;
  for (let i = 0; i < base64.length; i += 1) {
    const code = base64.charCodeAt(i);
    // Treat ASCII control + space as whitespace; base64 decoders commonly ignore these.
    if (code <= 0x20) {
      continue;
    }
    effectiveLen += 1;
  }

  if (effectiveLen === 0) {
    return 0;
  }

  let padding = 0;
  // Find last non-whitespace char(s) to detect '=' padding without allocating/copying.
  let end = base64.length - 1;
  while (end >= 0 && base64.charCodeAt(end) <= 0x20) {
    end -= 1;
  }
  if (end >= 0 && base64[end] === "=") {
    padding = 1;
    end -= 1;
    while (end >= 0 && base64.charCodeAt(end) <= 0x20) {
      end -= 1;
    }
    if (end >= 0 && base64[end] === "=") {
      padding = 2;
    }
  }

  const estimated = Math.floor((effectiveLen * 3) / 4) - padding;
  return Math.max(0, estimated);
}

function isBase64DataChar(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f
  );
}

function base64DataValue(code: number): number {
  if (code >= 0x41 && code <= 0x5a) {
    return code - 0x41;
  }
  if (code >= 0x61 && code <= 0x7a) {
    return code - 0x61 + 26;
  }
  if (code >= 0x30 && code <= 0x39) {
    return code - 0x30 + 52;
  }
  return code === 0x2b ? 62 : 63;
}

/**
 * Normalizes and validates a base64 string, returning canonical no-whitespace
 * base64 only when the input has valid alphabet, padding, and length.
 */
export function canonicalizeBase64(base64: string): string | undefined {
  // Validate in a single pass and collect contiguous non-whitespace runs as
  // slices. Appending per character instead (`current += char`) allocates one
  // V8 cons-string node (~25 bytes) per input character, all live at once —
  // enough to OOM the process on multi-megabyte attachment payloads.
  const runs: string[] = [];
  let runStart = -1;
  let cleanedLength = 0;
  let padding = 0;
  let sawPadding = false;
  let lastDataCode = 0;

  for (let i = 0; i < base64.length; i += 1) {
    const code = base64.charCodeAt(i);
    if (code <= 0x20) {
      if (runStart >= 0) {
        runs.push(base64.slice(runStart, i));
        runStart = -1;
      }
      continue;
    }
    if (code === 0x3d) {
      padding += 1;
      if (padding > 2) {
        return undefined;
      }
      sawPadding = true;
    } else if (sawPadding || !isBase64DataChar(code)) {
      return undefined;
    } else {
      lastDataCode = code;
    }
    if (runStart < 0) {
      runStart = i;
    }
    cleanedLength += 1;
  }
  if (runStart >= 0) {
    runs.push(runStart === 0 ? base64 : base64.slice(runStart));
  }
  if (cleanedLength === 0) {
    return undefined;
  }
  const remainder = cleanedLength % 4;
  if (remainder !== 0 && (sawPadding || remainder === 1)) {
    return undefined;
  }
  const effectivePadding = remainder === 0 ? padding : 4 - remainder;
  const padBitMask = effectivePadding === 2 ? 0x0f : effectivePadding === 1 ? 0x03 : 0;
  if (padBitMask !== 0 && (base64DataValue(lastDataCode) & padBitMask) !== 0) {
    return undefined;
  }
  // Already-canonical input (the common case: encoder output with no
  // whitespace) is returned as-is without copying.
  const cleaned = runs.length === 1 ? (runs[0] ?? "") : runs.join("");
  return remainder === 0 ? cleaned : cleaned + "=".repeat(4 - remainder);
}
