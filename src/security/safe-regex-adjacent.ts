// Adjacent unbounded twins (a*a*$) are ReDoS. Nested (a+)+ stays in safe-regex.ts.
// Only reject one adjacent emit with an equal signature. A required separator
// (JWT `.`, distinct literals) clears the pending twin. Learned #119702.

type QuantifierRead = {
  consumed: number;
  minRepeat: number;
  maxRepeat: number | null;
};

function readQuantifier(source: string, index: number): QuantifierRead | null {
  const ch = source[index];
  const lazy = source[index + 1] === "?" ? 2 : 1;
  if (ch === "*") {
    return { consumed: lazy, minRepeat: 0, maxRepeat: null };
  }
  if (ch === "+") {
    return { consumed: lazy, minRepeat: 1, maxRepeat: null };
  }
  if (ch === "?") {
    return { consumed: lazy, minRepeat: 0, maxRepeat: 1 };
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

function readEscapeAtom(source: string, index: number): { end: number; sig: string } {
  if (source[index] !== "\\") {
    return { end: index + 1, sig: source[index] ?? "" };
  }
  const next = source[index + 1];
  if (next === "p" || next === "P") {
    if (source[index + 2] === "{") {
      const close = source.indexOf("}", index + 3);
      if (close !== -1) {
        return { end: close + 1, sig: source.slice(index, close + 1) };
      }
    }
  }
  if (next === "u" && source[index + 2] === "{") {
    const close = source.indexOf("}", index + 3);
    if (close !== -1) {
      return { end: close + 1, sig: source.slice(index, close + 1) };
    }
  }
  if (next === "u" && index + 5 < source.length) {
    return { end: index + 6, sig: source.slice(index, index + 6) };
  }
  if (next === "x" && index + 3 < source.length) {
    return { end: index + 4, sig: source.slice(index, index + 4) };
  }
  if (next !== undefined) {
    return { end: index + 2, sig: source.slice(index, index + 2) };
  }
  return { end: index + 1, sig: "\\" };
}

function readClassAtom(source: string, index: number): { end: number; sig: string } {
  let i = index + 1;
  if (source[i] === "^") {
    i += 1;
  }
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === "]") {
      return { end: i + 1, sig: source.slice(index, i + 1) };
    }
    i += 1;
  }
  return { end: source.length, sig: source.slice(index) };
}

function readGroupAtom(
  source: string,
  index: number,
): { end: number; sig: string; zeroWidth: boolean } {
  const prefix = source.slice(index, index + 4);
  const zeroWidth =
    prefix.startsWith("(?=") ||
    prefix.startsWith("(?!") ||
    prefix.startsWith("(?<=") ||
    prefix.startsWith("(?<!");
  let depth = 1;
  let i = index + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === "[") {
      i = readClassAtom(source, i).end;
      continue;
    }
    if (source[i] === "(") {
      depth += 1;
    } else if (source[i] === ")") {
      depth -= 1;
    }
    i += 1;
  }
  return { end: i, sig: source.slice(index, i), zeroWidth };
}

function signaturesEqual(left: string, right: string, foldCase: boolean): boolean {
  if (left === right) {
    return true;
  }
  if (foldCase && left.length === 1 && right.length === 1) {
    return left.toLowerCase() === right.toLowerCase();
  }
  return false;
}

export function hasAdjacentUnboundedTwins(source: string, flags = ""): boolean {
  let pending: string | null = null;
  let i = 0;
  const foldCase = flags.includes("i");

  while (i < source.length) {
    const ch = source[i];
    if (ch === "^" || ch === "$") {
      i += 1;
      continue;
    }
    if (ch === "|" || ch === ")") {
      pending = null;
      i += 1;
      continue;
    }

    let end = i + 1;
    let sig = ch ?? "";
    let zeroWidth = false;
    if (ch === "\\") {
      const atom = readEscapeAtom(source, i);
      end = atom.end;
      sig = atom.sig;
    } else if (ch === "[") {
      const atom = readClassAtom(source, i);
      end = atom.end;
      sig = atom.sig;
    } else if (ch === "(") {
      const atom = readGroupAtom(source, i);
      end = atom.end;
      sig = atom.sig;
      zeroWidth = atom.zeroWidth;
    }

    i = end;
    const quantifier = readQuantifier(source, i);
    let unbounded = false;
    if (quantifier) {
      i += quantifier.consumed;
      unbounded = quantifier.maxRepeat === null;
    }

    if (unbounded) {
      if (pending !== null && signaturesEqual(pending, sig, foldCase)) {
        return true;
      }
      pending = sig;
      continue;
    }
    if (!zeroWidth) {
      pending = null;
    }
  }
  return false;
}
