// Tokenizes user-supplied regex sources for the safe-regex analyzer.

type QuantifierRead = {
  consumed: number;
  minRepeat: number;
  maxRepeat: number | null;
};

export type PatternToken =
  | { kind: "simple-token"; source: string }
  | { kind: "group-open"; contentStart: number }
  | { kind: "group-close"; start: number }
  | { kind: "alternation"; start: number; end: number }
  | { kind: "quantifier"; quantifier: QuantifierRead };

function readGroupContentStart(source: string, index: number): number {
  if (source[index + 1] !== "?") {
    return index + 1;
  }
  const marker = source[index + 2];
  if (marker === ":" || marker === "=" || marker === "!") {
    return index + 3;
  }
  if (marker !== "<") {
    return index + 1;
  }
  if (source[index + 3] === "=" || source[index + 3] === "!") {
    return index + 4;
  }
  const nameEnd = source.indexOf(">", index + 3);
  return nameEnd === -1 ? index + 1 : nameEnd + 1;
}

function readQuantifier(source: string, index: number): QuantifierRead | null {
  const ch = source[index];
  const consumed = source[index + 1] === "?" ? 2 : 1;
  if (ch === "*") {
    return { consumed, minRepeat: 0, maxRepeat: null };
  }
  if (ch === "+") {
    return { consumed, minRepeat: 1, maxRepeat: null };
  }
  if (ch === "?") {
    return { consumed, minRepeat: 0, maxRepeat: 1 };
  }
  if (ch !== "{") {
    return null;
  }

  let i = index + 1;
  while (i < source.length && /\d/.test(source.charAt(i))) {
    i += 1;
  }
  if (i === index + 1) {
    return null;
  }

  const minRepeat = Number.parseInt(source.slice(index + 1, i), 10);
  let maxRepeat: number | null = minRepeat;
  if (source[i] === ",") {
    i += 1;
    const maxStart = i;
    while (i < source.length && /\d/.test(source.charAt(i))) {
      i += 1;
    }
    maxRepeat = i === maxStart ? null : Number.parseInt(source.slice(maxStart, i), 10);
  }

  if (source[i] !== "}") {
    return null;
  }
  i += 1;
  if (source[i] === "?") {
    i += 1;
  }
  if (maxRepeat !== null && maxRepeat < minRepeat) {
    return null;
  }

  return { consumed: i - index, minRepeat, maxRepeat };
}

function isUnicodePropertyName(interior: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(=[A-Za-z0-9_]+)?$/.test(interior);
}

/**
 * Last index of one escape atom (`\p{L}`, `\u0041`, `\x41`), else the
 * one-char escape after `\`. Do not swallow `\p{(a+)+}`: without `u`,
 * `\p` is an identity escape and the group must still be analyzed.
 */
export function readEscapeAtomEnd(source: string, backslashIndex: number): number {
  if (backslashIndex + 1 >= source.length) {
    return backslashIndex;
  }
  const kind = source[backslashIndex + 1];
  const afterKind = backslashIndex + 2;

  if ((kind === "p" || kind === "P") && source[afterKind] === "{") {
    const close = source.indexOf("}", afterKind + 1);
    if (close !== -1 && isUnicodePropertyName(source.slice(afterKind + 1, close))) {
      return close;
    }
    return backslashIndex + 1;
  }

  if (kind === "u" && source[afterKind] === "{") {
    const close = source.indexOf("}", afterKind + 1);
    if (close !== -1 && /^[0-9a-fA-F]{1,6}$/.test(source.slice(afterKind + 1, close))) {
      const cp = Number.parseInt(source.slice(afterKind + 1, close), 16);
      if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff) {
        return close;
      }
    }
    return backslashIndex + 1;
  }

  if (kind === "u" && /^[0-9a-fA-F]{4}/.test(source.slice(afterKind, afterKind + 4))) {
    return afterKind + 3;
  }

  if (kind === "x" && /^[0-9a-fA-F]{2}/.test(source.slice(afterKind, afterKind + 2))) {
    return afterKind + 1;
  }

  return backslashIndex + 1;
}

export function tokenizePattern(source: string): PatternToken[] {
  const tokens: PatternToken[] = [];

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (ch === "\\") {
      const end = readEscapeAtomEnd(source, i);
      tokens.push({ kind: "simple-token", source: source.slice(i, end + 1) });
      i = end;
      continue;
    }

    if (ch === "[") {
      const start = i;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "]") {
          break;
        }
        i += 1;
      }
      tokens.push({
        kind: "simple-token",
        source: source.slice(start, Math.min(i + 1, source.length)),
      });
      continue;
    }

    if (ch === "(") {
      const contentStart = readGroupContentStart(source, i);
      tokens.push({ kind: "group-open", contentStart });
      i = contentStart - 1;
      continue;
    }

    if (ch === ")") {
      tokens.push({ kind: "group-close", start: i });
      continue;
    }

    if (ch === "|") {
      tokens.push({ kind: "alternation", start: i, end: i + 1 });
      continue;
    }

    const quantifier = readQuantifier(source, i);
    if (quantifier) {
      tokens.push({ kind: "quantifier", quantifier });
      i += quantifier.consumed - 1;
      continue;
    }

    tokens.push({ kind: "simple-token", source: source.slice(i, i + 1) });
  }

  return tokens;
}
