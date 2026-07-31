import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

/** Masks credential-like values without splitting UTF-16 surrogate pairs at the edges. */
export function maskApiKey(value: string): string {
  const trimmed = stripControlCharacters(value).trim();
  if (!trimmed) {
    return "missing";
  }
  if (trimmed.length <= 6) {
    return `${sliceUtf16Safe(trimmed, 0, 1)}...${sliceUtf16Safe(trimmed, -1)}`;
  }
  if (trimmed.length <= 16) {
    return `${sliceUtf16Safe(trimmed, 0, 2)}...${sliceUtf16Safe(trimmed, -2)}`;
  }
  return `${sliceUtf16Safe(trimmed, 0, 8)}...${sliceUtf16Safe(trimmed, -8)}`;
}

function stripControlCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    const isControl = (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
    if (!isControl) {
      result += character;
    }
  }
  return result;
}
