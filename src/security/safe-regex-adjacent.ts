// Adjacent unbounded-repeat overlap for the safe-regex analyzer.

function isZeroWidthAtom(language: string): boolean {
  return (
    language === "" ||
    language === "^" ||
    language === "$" ||
    language === "\\b" ||
    language === "\\B" ||
    language === "(?:)" ||
    language === "(?=)" ||
    language === "(?!)" ||
    language === "(?<=)" ||
    language === "(?<!)"
  );
}

export function isZeroWidthLanguage(language: string, alternatives: readonly string[]): boolean {
  return isZeroWidthAtom(language) || alternatives.every((alt) => isZeroWidthAtom(alt));
}

function unionPendingAlts(left: readonly string[], right: readonly string[]): string[] {
  const seen = new Set(left);
  const out = [...left];
  for (const alt of right) {
    if (!seen.has(alt)) {
      seen.add(alt);
      out.push(alt);
    }
  }
  return out;
}

export function nextPendingAdjacentAlts(
  previous: string[] | null,
  newAlts: readonly string[],
  minRepeat: number,
  maxRepeat: number | null,
  isZeroWidth: boolean,
): string[] | null {
  if (isZeroWidth) {
    return previous;
  }
  if (maxRepeat === null && newAlts.length > 0) {
    if (minRepeat === 0 && previous) {
      return unionPendingAlts(previous, newAlts);
    }
    return [...newAlts];
  }
  if (minRepeat === 0) {
    return previous;
  }
  return null;
}

export function isLookaroundPrefix(source: string, contentStart: number): boolean {
  const prefix = source.slice(Math.max(0, contentStart - 4), contentStart);
  return (
    prefix.endsWith("?=") ||
    prefix.endsWith("?!") ||
    prefix.endsWith("?<=") ||
    prefix.endsWith("?<!")
  );
}

function walkRegexSource(
  source: string,
  visit: (ch: string, index: number, depth: number) => void,
): boolean {
  let depth = 0;
  let inClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === undefined) {
      continue;
    }
    if (ch === "\\") {
      index += 1;
      continue;
    }
    if (inClass) {
      if (ch === "]") {
        inClass = false;
      }
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      visit(ch, index, depth);
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
      visit(ch, index, depth);
      continue;
    }
    visit(ch, index, depth);
  }
  return depth === 0;
}

function isSingleWrappingGroup(source: string): boolean {
  if (source.length < 2 || source[0] !== "(" || source[source.length - 1] !== ")") {
    return false;
  }
  let closedEarly = false;
  const balanced = walkRegexSource(source, (ch, index, depth) => {
    if (ch === ")" && depth === 0 && index !== source.length - 1) {
      closedEarly = true;
    }
  });
  return balanced && !closedEarly;
}

function tryUnwrapOuterGroup(source: string): string | null {
  if (!isSingleWrappingGroup(source)) {
    return null;
  }
  if (source.startsWith("(?=") || source.startsWith("(?!") || source.startsWith("(?<=")) {
    return null;
  }
  if (source.startsWith("(?:")) {
    return source.slice(3, -1);
  }
  if (source.startsWith("(?")) {
    return null;
  }
  return source.slice(1, -1);
}

function splitTopLevelAlternatives(source: string): string[] {
  const cuts: number[] = [];
  walkRegexSource(source, (ch, index, depth) => {
    if (ch === "|" && depth === 0) {
      cuts.push(index);
    }
  });
  if (cuts.length === 0) {
    return [source];
  }
  const parts: string[] = [];
  let start = 0;
  for (const cut of cuts) {
    parts.push(source.slice(start, cut));
    start = cut + 1;
  }
  parts.push(source.slice(start));
  return parts;
}

function flattenAlternatives(alternatives: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (raw: string) => {
    let current = raw;
    for (let depth = 0; depth < 8; depth += 1) {
      const inner = tryUnwrapOuterGroup(current);
      if (inner === null) {
        break;
      }
      current = inner;
    }
    const parts = splitTopLevelAlternatives(current);
    if (parts.length > 1) {
      for (const part of parts) {
        visit(part);
      }
      return;
    }
    if (!seen.has(current)) {
      seen.add(current);
      out.push(current);
    }
  };
  for (const alternative of alternatives) {
    visit(alternative);
  }
  return out.length > 0 ? out : [""];
}

export function adjacentRepeatsOverlap(
  leftAlts: readonly string[],
  rightAlts: readonly string[],
  ignoreCase: boolean,
  singleTokenPairOverlaps: (left: string, right: string, ignoreCase: boolean) => boolean,
): boolean {
  const leftFlat = flattenAlternatives(leftAlts);
  const rightFlat = flattenAlternatives(rightAlts);
  for (const left of leftFlat) {
    for (const right of rightFlat) {
      if (left === right) {
        return true;
      }
      if (singleTokenPairOverlaps(left, right, ignoreCase)) {
        return true;
      }
    }
  }
  return false;
}
