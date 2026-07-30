// Performs lightweight safe-regex checks for user-supplied patterns.
import { expectDefined } from "@openclaw/normalization-core";
type QuantifierRead = {
  consumed: number;
  minRepeat: number;
  maxRepeat: number | null;
};

type TokenState = {
  containsRepetition: boolean;
  hasAmbiguousAlternation: boolean;
  minLength: number;
  maxLength: number;
  atoms: string[] | null;
  signature: string;
};

type ParseFrame = {
  lastToken: TokenState | null;
  containsRepetition: boolean;
  hasAmbiguousAlternation: boolean;
  hasAlternation: boolean;
  branchMinLength: number;
  branchMaxLength: number;
  altMinLength: number | null;
  altMaxLength: number | null;
  branchAtoms: string[] | null;
  alternativeAtoms: Array<string[] | null>;
  branchSignatures: string[];
  alternativeSignatures: string[][];
};

type PatternToken =
  | { kind: "simple-token"; source: string; zeroWidth: boolean }
  | { kind: "group-open"; zeroWidth: boolean }
  | { kind: "group-close" }
  | { kind: "alternation" }
  | { kind: "quantifier"; quantifier: QuantifierRead };

const SAFE_REGEX_CACHE_MAX = 256;
const SAFE_REGEX_TEST_WINDOW = 2048;
export type SafeRegexRejectReason = "empty" | "unsafe-nested-repetition" | "invalid-regex";

export type SafeRegexCompileResult =
  | {
      regex: RegExp;
      source: string;
      flags: string;
      reason: null;
    }
  | {
      regex: null;
      source: string;
      flags: string;
      reason: SafeRegexRejectReason;
    };

const safeRegexCache = new Map<string, SafeRegexCompileResult>();

function createParseFrame(): ParseFrame {
  return {
    lastToken: null,
    containsRepetition: false,
    hasAmbiguousAlternation: false,
    hasAlternation: false,
    branchMinLength: 0,
    branchMaxLength: 0,
    altMinLength: null,
    altMaxLength: null,
    branchAtoms: [],
    alternativeAtoms: [],
    branchSignatures: [],
    alternativeSignatures: [],
  };
}

function addLength(left: number, right: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return Number.POSITIVE_INFINITY;
  }
  return left + right;
}

function multiplyLength(length: number, factor: number): number {
  if (!Number.isFinite(length)) {
    return factor === 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return length * factor;
}

function recordAlternative(frame: ParseFrame): void {
  frame.alternativeAtoms.push(frame.branchAtoms);
  frame.alternativeSignatures.push(frame.branchSignatures);
  if (frame.altMinLength === null || frame.altMaxLength === null) {
    frame.altMinLength = frame.branchMinLength;
    frame.altMaxLength = frame.branchMaxLength;
    return;
  }
  frame.altMinLength = Math.min(frame.altMinLength, frame.branchMinLength);
  frame.altMaxLength = Math.max(frame.altMaxLength, frame.branchMaxLength);
}

const ASCII_ATOM_SAMPLES = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code));

function readEscapedLiteral(source: string, index: number): { value: string; next: number } | null {
  const marker = source[index + 1];
  if (!marker) {
    return null;
  }
  if (marker === "x") {
    const hex = source.slice(index + 2, index + 4);
    return /^[\da-f]{2}$/i.test(hex)
      ? { value: String.fromCodePoint(Number.parseInt(hex, 16)), next: index + 4 }
      : null;
  }
  if (marker === "u") {
    if (source[index + 2] === "{") {
      const closing = source.indexOf("}", index + 3);
      if (closing < 0) {
        return null;
      }
      const hex = source.slice(index + 3, closing);
      const codePoint = /^[\da-f]+$/i.test(hex) ? Number.parseInt(hex, 16) : Number.NaN;
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? { value: String.fromCodePoint(codePoint), next: closing + 1 }
        : null;
    }
    const hex = source.slice(index + 2, index + 6);
    return /^[\da-f]{4}$/i.test(hex)
      ? { value: String.fromCodePoint(Number.parseInt(hex, 16)), next: index + 6 }
      : null;
  }
  if (/^[\\^$.*+?()[\]{}|/-]$/.test(marker)) {
    return { value: marker, next: index + 2 };
  }
  return null;
}

function finiteCharacterClassValues(source: string): string[] | null {
  if (!source.startsWith("[") || !source.endsWith("]") || source.startsWith("[^")) {
    return null;
  }
  const values = new Set<string>();
  const elements: Array<{ value: string; escaped: boolean }> = [];
  for (let index = 1; index < source.length - 1;) {
    if (source[index] === "\\") {
      const escaped = readEscapedLiteral(source, index);
      if (!escaped) {
        return null;
      }
      elements.push({ value: escaped.value, escaped: true });
      index = escaped.next;
      continue;
    }
    const codePoint = source.codePointAt(index);
    if (codePoint === undefined) {
      return null;
    }
    const value = String.fromCodePoint(codePoint);
    elements.push({ value, escaped: false });
    index += value.length;
  }
  for (let index = 0; index < elements.length; index += 1) {
    const element = expectDefined(elements[index], "character class element");
    const hyphen = elements[index + 1];
    const rangeEnd = elements[index + 2];
    if (hyphen?.value === "-" && !hyphen.escaped && rangeEnd) {
      const startCodePoint = expectDefined(element.value.codePointAt(0), "range start");
      const endCodePoint = expectDefined(rangeEnd.value.codePointAt(0), "range end");
      if (endCodePoint < startCodePoint || endCodePoint - startCodePoint > 1024) {
        return null;
      }
      for (let codePoint = startCodePoint; codePoint <= endCodePoint; codePoint += 1) {
        values.add(String.fromCodePoint(codePoint));
      }
      index += 2;
    } else {
      values.add(element.value);
    }
    if (values.size > 2048) {
      return null;
    }
  }
  return [...values];
}

function finiteAtomValues(source: string): string[] | null {
  const classValues = finiteCharacterClassValues(source);
  if (classValues) {
    return classValues;
  }
  if (source === "\\d") {
    return Array.from({ length: 10 }, (_, index) => String(index));
  }
  if (source === "\\w") {
    return Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz0123456789");
  }
  if (source === "\\s") {
    return [
      "\t",
      "\n",
      "\v",
      "\f",
      "\r",
      " ",
      "\u00a0",
      "\u1680",
      "\u2000",
      "\u2001",
      "\u2002",
      "\u2003",
      "\u2004",
      "\u2005",
      "\u2006",
      "\u2007",
      "\u2008",
      "\u2009",
      "\u200a",
      "\u2028",
      "\u2029",
      "\u202f",
      "\u205f",
      "\u3000",
      "\ufeff",
    ];
  }
  if (source.startsWith("\\")) {
    const escaped = readEscapedLiteral(source, 0);
    return escaped?.next === source.length ? [escaped.value] : null;
  }
  const characters = Array.from(source);
  return characters.length === 1 && !/^[.^$*+?()[\]{}|]$/.test(source) ? characters : null;
}

function atomsMayOverlap(left: string, right: string, flags: string): boolean {
  if (left === right) {
    return true;
  }
  if (/^\\(?:[1-9]\d*|k<)/.test(left) || /^\\(?:[1-9]\d*|k<)/.test(right)) {
    // Backreferences only have meaning in the complete pattern's capture context.
    // A standalone atom probe cannot prove them disjoint from another branch.
    return true;
  }
  try {
    const safeFlags = flags.replace(/[gy]/g, "");
    const leftRegex = new RegExp(`^(?:${left})$`, safeFlags);
    const rightRegex = new RegExp(`^(?:${right})$`, safeFlags);
    const leftValues = finiteAtomValues(left);
    const rightValues = finiteAtomValues(right);
    const candidates = new Set([
      ...ASCII_ATOM_SAMPLES,
      ...Array.from(left),
      ...Array.from(right),
      ...(leftValues ?? []),
      ...(rightValues ?? []),
    ]);
    if ([...candidates].some((sample) => leftRegex.test(sample) && rightRegex.test(sample))) {
      return true;
    }
    // A finite side proves disjointness once every value has been tested.
    // Unicode ignore-case can add folds outside that finite source enumeration.
    const hasNonExhaustiveCaseFold =
      flags.includes("i") &&
      (flags.includes("u") || flags.includes("v")) &&
      (leftValues === null || rightValues === null);
    // Unknown atom languages fail closed so sampling can never declare them safe.
    return hasNonExhaustiveCaseFold || (leftValues === null && rightValues === null);
  } catch {
    return true;
  }
}

function alternativesOverlap(alternatives: Array<string[] | null>, flags: string): boolean {
  for (let leftIndex = 0; leftIndex < alternatives.length; leftIndex += 1) {
    const left = alternatives[leftIndex];
    if (!left) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < alternatives.length; rightIndex += 1) {
      const right = alternatives[rightIndex];
      if (
        right &&
        left.length === right.length &&
        left.every((atom, index) =>
          atomsMayOverlap(
            atom,
            expectDefined(right[index], "equal-length alternative atom"),
            flags,
          ),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function alternativesRepeatExactly(alternatives: string[][]): boolean {
  const signatures = new Set<string>();
  for (const alternative of alternatives) {
    const signature = JSON.stringify(alternative);
    if (signatures.has(signature)) {
      return true;
    }
    signatures.add(signature);
  }
  return false;
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

function tokenizePattern(source: string): PatternToken[] {
  const tokens: PatternToken[] = [];

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (ch === "\\") {
      let atomEnd = i + 2;
      if (
        (source[i + 1] === "p" || source[i + 1] === "P" || source[i + 1] === "u") &&
        source[i + 2] === "{"
      ) {
        const closing = source.indexOf("}", i + 3);
        atomEnd = closing < 0 ? atomEnd : closing + 1;
      } else if (source[i + 1] === "u") {
        atomEnd = Math.min(source.length, i + 6);
      } else if (source[i + 1] === "x") {
        atomEnd = Math.min(source.length, i + 4);
      } else if (source[i + 1] === "k" && source[i + 2] === "<") {
        const closing = source.indexOf(">", i + 3);
        atomEnd = closing < 0 ? atomEnd : closing + 1;
      }
      const atom = source.slice(i, atomEnd);
      i = atomEnd - 1;
      tokens.push({
        kind: "simple-token",
        source: atom,
        zeroWidth: atom === "\\b" || atom === "\\B",
      });
      continue;
    }

    if (ch === "[") {
      const start = i;
      for (i += 1; i < source.length; i += 1) {
        if (source[i] === "\\") {
          i += 1;
        } else if (source[i] === "]") {
          break;
        }
      }
      tokens.push({ kind: "simple-token", source: source.slice(start, i + 1) });
      continue;
    }

    if (ch === "(") {
      let zeroWidth = false;
      const shortPrefix = source.slice(i + 1, i + 3);
      const longPrefix = source.slice(i + 1, i + 4);
      if (longPrefix === "?<=" || longPrefix === "?<!") {
        zeroWidth = true;
        i += 3;
      } else if (shortPrefix === "?=" || shortPrefix === "?!") {
        zeroWidth = true;
        i += 2;
      } else if (shortPrefix === "?:") {
        i += 2;
      } else if (shortPrefix === "?<") {
        const closing = source.indexOf(">", i + 3);
        if (closing >= 0) {
          i = closing;
        }
      }
      tokens.push({ kind: "group-open", zeroWidth });
      continue;
    }

    if (ch === ")") {
      tokens.push({ kind: "group-close" });
      continue;
    }

    if (ch === "|") {
      tokens.push({ kind: "alternation" });
      continue;
    }

    const quantifier = readQuantifier(source, i);
    if (quantifier) {
      tokens.push({ kind: "quantifier", quantifier });
      i += quantifier.consumed - 1;
      continue;
    }

    const codePoint = expectDefined(source.codePointAt(i), "pattern code point");
    const atom = String.fromCodePoint(codePoint);
    tokens.push({
      kind: "simple-token",
      source: atom,
      zeroWidth: atom === "^" || atom === "$",
    });
    i += atom.length - 1;
  }

  return tokens;
}

function analyzeTokensForNestedRepetition(tokens: PatternToken[], flags: string): boolean {
  const frames: ParseFrame[] = [createParseFrame()];

  const emitToken = (token: TokenState) => {
    const frame = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
    frame.lastToken = token;
    if (token.containsRepetition) {
      frame.containsRepetition = true;
    }
    if (token.hasAmbiguousAlternation) {
      frame.hasAmbiguousAlternation = true;
    }
    frame.branchMinLength = addLength(frame.branchMinLength, token.minLength);
    frame.branchMaxLength = addLength(frame.branchMaxLength, token.maxLength);
    if (frame.branchAtoms && token.atoms) {
      frame.branchAtoms.push(...token.atoms);
    } else {
      frame.branchAtoms = null;
    }
    frame.branchSignatures.push(token.signature);
  };

  const emitSimpleToken = (source: string, zeroWidth: boolean) => {
    emitToken({
      containsRepetition: false,
      hasAmbiguousAlternation: zeroWidth,
      minLength: zeroWidth ? 0 : 1,
      maxLength: zeroWidth ? 0 : 1,
      atoms: zeroWidth ? null : [source],
      signature: source,
    });
  };

  for (const token of tokens) {
    if (token.kind === "simple-token") {
      emitSimpleToken(token.source, token.zeroWidth);
      continue;
    }

    if (token.kind === "group-open") {
      const frame = createParseFrame();
      frame.hasAmbiguousAlternation = token.zeroWidth;
      frames.push(frame);
      continue;
    }

    if (token.kind === "group-close") {
      if (frames.length > 1) {
        const frame = frames.pop() as ParseFrame;
        if (frame.hasAlternation) {
          recordAlternative(frame);
        }
        const groupMinLength = frame.hasAlternation
          ? (frame.altMinLength ?? 0)
          : frame.branchMinLength;
        const groupMaxLength = frame.hasAlternation
          ? (frame.altMaxLength ?? 0)
          : frame.branchMaxLength;
        emitToken({
          containsRepetition: frame.containsRepetition,
          hasAmbiguousAlternation:
            frame.hasAmbiguousAlternation ||
            (frame.hasAlternation &&
              frame.altMinLength !== null &&
              frame.altMaxLength !== null &&
              (frame.altMinLength !== frame.altMaxLength ||
                alternativesOverlap(frame.alternativeAtoms, flags) ||
                alternativesRepeatExactly(frame.alternativeSignatures))),
          minLength: groupMinLength,
          maxLength: groupMaxLength,
          atoms: frame.hasAlternation ? null : frame.branchAtoms,
          signature: JSON.stringify(
            frame.hasAlternation ? frame.alternativeSignatures : frame.branchSignatures,
          ),
        });
      }
      continue;
    }

    if (token.kind === "alternation") {
      const frame = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
      frame.hasAlternation = true;
      recordAlternative(frame);
      frame.branchMinLength = 0;
      frame.branchMaxLength = 0;
      frame.branchAtoms = [];
      frame.branchSignatures = [];
      frame.lastToken = null;
      continue;
    }

    const frame = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
    const previousToken = frame.lastToken;
    if (!previousToken) {
      continue;
    }
    if (previousToken.containsRepetition) {
      return true;
    }
    if (previousToken.hasAmbiguousAlternation && token.quantifier.maxRepeat === null) {
      return true;
    }

    const previousMinLength = previousToken.minLength;
    const previousMaxLength = previousToken.maxLength;
    previousToken.minLength = multiplyLength(previousToken.minLength, token.quantifier.minRepeat);
    previousToken.maxLength =
      token.quantifier.maxRepeat === null
        ? Number.POSITIVE_INFINITY
        : multiplyLength(previousToken.maxLength, token.quantifier.maxRepeat);
    previousToken.containsRepetition = true;
    previousToken.atoms = null;
    frame.containsRepetition = true;
    frame.branchAtoms = null;
    frame.branchMinLength = frame.branchMinLength - previousMinLength + previousToken.minLength;

    const branchMaxBase =
      Number.isFinite(frame.branchMaxLength) && Number.isFinite(previousMaxLength)
        ? frame.branchMaxLength - previousMaxLength
        : Number.POSITIVE_INFINITY;
    frame.branchMaxLength = addLength(branchMaxBase, previousToken.maxLength);
  }

  return false;
}

function testRegexFromStart(regex: RegExp, value: string): boolean {
  regex.lastIndex = 0;
  return regex.test(value);
}

export function testRegexWithBoundedInput(
  regex: RegExp,
  input: string,
  maxWindow = SAFE_REGEX_TEST_WINDOW,
): boolean {
  if (maxWindow <= 0) {
    return false;
  }
  if (input.length <= maxWindow) {
    return testRegexFromStart(regex, input);
  }
  const head = input.slice(0, maxWindow);
  if (testRegexFromStart(regex, head)) {
    return true;
  }
  return testRegexFromStart(regex, input.slice(-maxWindow));
}

function hasNestedRepetition(source: string, flags: string): boolean {
  // Conservative parser: tokenize first, then check if repeated tokens/groups are repeated again.
  // Non-goal: complete regex AST support; keep strict enough for config safety checks.
  return analyzeTokensForNestedRepetition(tokenizePattern(source), flags);
}

export function compileSafeRegexDetailed(source: string, flags = ""): SafeRegexCompileResult {
  const trimmed = source.trim();
  if (!trimmed) {
    return { regex: null, source: trimmed, flags, reason: "empty" };
  }
  const cacheKey = `${flags}::${trimmed}`;
  if (safeRegexCache.has(cacheKey)) {
    return (
      safeRegexCache.get(cacheKey) ?? {
        regex: null,
        source: trimmed,
        flags,
        reason: "invalid-regex",
      }
    );
  }

  let result: SafeRegexCompileResult;
  if (hasNestedRepetition(trimmed, flags)) {
    result = { regex: null, source: trimmed, flags, reason: "unsafe-nested-repetition" };
  } else {
    try {
      result = { regex: new RegExp(trimmed, flags), source: trimmed, flags, reason: null };
    } catch {
      result = { regex: null, source: trimmed, flags, reason: "invalid-regex" };
    }
  }

  safeRegexCache.set(cacheKey, result);
  if (safeRegexCache.size > SAFE_REGEX_CACHE_MAX) {
    const oldestKey = safeRegexCache.keys().next().value;
    if (oldestKey) {
      safeRegexCache.delete(oldestKey);
    }
  }
  return result;
}

export function compileSafeRegex(source: string, flags = ""): RegExp | null {
  return compileSafeRegexDetailed(source, flags).regex;
}
