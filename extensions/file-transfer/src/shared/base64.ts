// File Transfer plugin module implements strict base64 preflight validation.

function isBase64DataChar(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f ||
    code === 0x2d ||
    code === 0x5f
  );
}

/** Validates base64 structure and returns its decoded size without allocating a decode buffer. */
export function inspectStrictBase64(value: string): number | undefined {
  let dataChars = 0;
  let padding = 0;
  let sawPadding = false;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x3d) {
      padding += 1;
      if (padding > 2) {
        return undefined;
      }
      sawPadding = true;
      continue;
    }
    if (sawPadding || !isBase64DataChar(code)) {
      return undefined;
    }
    dataChars += 1;
  }

  if (dataChars === 0) {
    return padding === 0 ? 0 : undefined;
  }
  const remainder = dataChars % 4;
  if (padding === 0) {
    return remainder === 1 ? undefined : Math.floor((dataChars * 3) / 4);
  }
  if (dataChars + padding < 4 || (dataChars + padding) % 4 !== 0) {
    return undefined;
  }
  if ((padding === 1 && remainder !== 3) || (padding === 2 && remainder !== 2)) {
    return undefined;
  }
  return Math.floor((dataChars * 3) / 4);
}
