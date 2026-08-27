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
  // Single validating pass; the output buffer is allocated lazily on the first
  // whitespace and bounded by the input length, so canonical input returns
  // unchanged with zero allocations and no input shape multiplies intermediates.
  let out: Buffer | undefined;
  let outLen = 0;
  let padding = 0;
  let sawPadding = false;
  let lastDataCode = 0;

  for (let i = 0; i < base64.length; i += 1) {
    const code = base64.charCodeAt(i);
    if (code <= 0x20) {
      if (out === undefined) {
        // First whitespace: backfill the validated prefix [0, i).
        out = Buffer.allocUnsafe(base64.length - 1);
        for (let j = 0; j < i; j += 1) {
          out[j] = base64.charCodeAt(j);
        }
        outLen = i;
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
    if (out !== undefined) {
      out[outLen] = code;
      outLen += 1;
    }
  }
  const cleanedLength = out === undefined ? base64.length : outLen;
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
  // Every kept character was validated against the base64 alphabet (ASCII),
  // so a latin1 decode reproduces them exactly.
  const cleaned = out === undefined ? base64 : out.subarray(0, outLen).toString("latin1");
  return remainder === 0 ? cleaned : cleaned + "=".repeat(4 - remainder);
}
