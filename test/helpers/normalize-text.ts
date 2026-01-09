function stripAnsi(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code !== 27) {
      out += input[i];
      continue;
    }

    const next = input[i + 1];
    if (next !== "[") continue;
    i += 1;

    while (i + 1 < input.length) {
      i += 1;
      const c = input[i];
      if (!c) break;
      const isLetter =
        (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "~";
      if (isLetter) break;
    }
  }
  return out;
}

export function normalizeTestText(input: string): string {
  return stripAnsi(input)
    .replaceAll("\r\n", "\n")
    .replaceAll("…", "...")
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "?")
    .replace(/[\uD800-\uDFFF]/g, "?");
}
