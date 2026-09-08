/** Split only outside quotes; entity-tags keep backslashes literal instead of escaping quotes. */
export function splitHttpHeaderValue(
  value: string,
  delimiter: string,
  quoteMode: "quoted-string" | "opaque-tag",
): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && quoteMode === "quoted-string" && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === delimiter) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  if (quoted || escaped) {
    return null;
  }
  parts.push(value.slice(start));
  return parts;
}
