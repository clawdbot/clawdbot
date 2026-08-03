// Performs lightweight safe-regex checks for user-supplied patterns.
import { expectDefined } from "@openclaw/normalization-core";
import {
  alternativesOverlap,
  readEscapedLiteral,
  readLegacyOctalEscape,
} from "./safe-regex-atom-overlap.js";

type QuantifierRead = {
  consumed: number;
  minRepeat: number;
  maxRepeat: number | null;
};

type TokenState = {
  containsRepetition: boolean;
  containsAlternation: boolean;
  hasAmbiguousAlternation: boolean;
  minLength: number;
  maxLength: number;
  paths: string[][] | null;
  signature: string;
};

type ParseFrame = {
  captureKeys: string[];
  zeroWidth: boolean;
  opaque: boolean;
  lastToken: TokenState | null;
  containsRepetition: boolean;
  containsAlternation: boolean;
  hasAmbiguousAlternation: boolean;
  hasAlternation: boolean;
  branchMinLength: number;
  branchMaxLength: number;
  altMinLength: number | null;
  altMaxLength: number | null;
  branchPaths: string[][] | null;
  alternativePaths: Array<string[][] | null>;
  branchSignatures: string[];
  alternativeSignatures: string[][];
};

type PatternToken =
  | {
      kind: "simple-token";
      source: string;
      zeroWidth: boolean;
      opaque?: boolean;
      ambiguousWhenRepeated?: boolean;
      backreferenceKey?: string;
    }
  | { kind: "group-open"; zeroWidth: boolean; opaque: boolean; captureKeys: string[] }
  | { kind: "group-close" }
  | { kind: "alternation" }
  | { kind: "quantifier"; quantifier: QuantifierRead };

const SAFE_REGEX_CACHE_MAX = 256;
const SAFE_REGEX_TEST_WINDOW = 2048;
// Bound recursive branch expansion; overflow becomes unknown and therefore unsafe
// when an enclosing repetition needs an overlap verdict.
const MAX_ALTERNATIVE_PATHS = 64;
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

function createParseFrame(
  zeroWidth = false,
  opaque = false,
  captureKeys: string[] = [],
): ParseFrame {
  return {
    captureKeys,
    zeroWidth,
    opaque,
    lastToken: null,
    containsRepetition: false,
    containsAlternation: false,
    hasAmbiguousAlternation: false,
    hasAlternation: false,
    branchMinLength: 0,
    branchMaxLength: 0,
    altMinLength: null,
    altMaxLength: null,
    branchPaths: [[]],
    alternativePaths: [],
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
  frame.alternativePaths.push(frame.branchPaths);
  frame.alternativeSignatures.push(frame.branchSignatures);
  if (frame.altMinLength === null || frame.altMaxLength === null) {
    frame.altMinLength = frame.branchMinLength;
    frame.altMaxLength = frame.branchMaxLength;
    return;
  }
  frame.altMinLength = Math.min(frame.altMinLength, frame.branchMinLength);
  frame.altMaxLength = Math.max(frame.altMaxLength, frame.branchMaxLength);
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

function vSetHasAmbiguousStrings(source: string): boolean {
  const stringMatches = Array.from(source.matchAll(/\\q\{([^}]*)\}/g));
  const strings = stringMatches.flatMap((match) => (match[1] ?? "").split("|"));
  if (strings.length === 0) {
    return false;
  }
  for (let leftIndex = 0; leftIndex < strings.length; leftIndex += 1) {
    const left = expectDefined(strings[leftIndex], "UnicodeSets string member");
    for (let rightIndex = leftIndex + 1; rightIndex < strings.length; rightIndex += 1) {
      const right = expectDefined(strings[rightIndex], "UnicodeSets string member");
      if (left.startsWith(right) || right.startsWith(left)) {
        return true;
      }
    }
  }

  let characterSource = source;
  for (const match of stringMatches) {
    characterSource = characterSource.replace(match[0], "");
  }
  const characters = new Set<string>();
  for (let index = 1; index < characterSource.length - 1;) {
    const ch = characterSource[index];
    if (ch === "\\") {
      const escaped = readEscapedLiteral(characterSource, index);
      if (!escaped) {
        return true;
      }
      characters.add(escaped.value);
      index = escaped.next;
      continue;
    }
    const value = String.fromCodePoint(
      expectDefined(characterSource.codePointAt(index), "UnicodeSets character"),
    );
    index += value.length;
    if (value !== "[" && value !== "]" && value !== "&" && value !== "-") {
      characters.add(value);
    }
  }
  return strings.some(
    (value) => value.length > 1 && Array.from(value).every((ch) => characters.has(ch)),
  );
}

function vPropertyMayContainStrings(source: string): boolean {
  return /\\p\{(?:Basic_Emoji|Emoji_Keycap_Sequence|RGI_Emoji(?:_Modifier_Sequence|_Flag_Sequence|_Tag_Sequence|_ZWJ_Sequence)?)\}/.test(
    source,
  );
}

function tokenizePattern(source: string, flags: string): PatternToken[] {
  const tokens: PatternToken[] = [];
  const unicodeAware = flags.includes("u") || flags.includes("v");
  let captureIndex = 0;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (ch === "\\") {
      let atomEnd = i + 2;
      if (
        (source[i + 1] === "p" || source[i + 1] === "P" || source[i + 1] === "u") &&
        unicodeAware &&
        source[i + 2] === "{"
      ) {
        const closing = source.indexOf("}", i + 3);
        atomEnd = closing < 0 ? atomEnd : closing + 1;
      } else if (source[i + 1] === "u") {
        const hex = source.slice(i + 2, i + 6);
        atomEnd = /^[\da-f]{4}$/i.test(hex) ? i + 6 : i + 2;
        const codeUnit = Number.parseInt(hex, 16);
        if (
          unicodeAware &&
          atomEnd === i + 6 &&
          codeUnit >= 0xd800 &&
          codeUnit <= 0xdbff &&
          source.slice(atomEnd, atomEnd + 2) === "\\u"
        ) {
          const trailingHex = source.slice(atomEnd + 2, atomEnd + 6);
          const trailingCodeUnit = Number.parseInt(trailingHex, 16);
          if (
            /^[\da-f]{4}$/i.test(trailingHex) &&
            trailingCodeUnit >= 0xdc00 &&
            trailingCodeUnit <= 0xdfff
          ) {
            atomEnd += 6;
          }
        }
      } else if (source[i + 1] === "x") {
        const hex = source.slice(i + 2, i + 4);
        atomEnd = /^[\da-f]{2}$/i.test(hex) ? i + 4 : i + 2;
      } else if (source[i + 1] === "k" && source[i + 2] === "<") {
        const closing = source.indexOf(">", i + 3);
        atomEnd = closing < 0 ? atomEnd : closing + 1;
      } else if (source[i + 1] === "c" && /^[a-z]$/i.test(source[i + 2] ?? "")) {
        atomEnd = i + 3;
      } else if (!unicodeAware && /^[0-7]$/.test(source[i + 1] ?? "")) {
        atomEnd = readLegacyOctalEscape(source, i)?.next ?? i + 2;
      } else if (/^[1-9]$/.test(source[i + 1] ?? "")) {
        atomEnd = i + 1 + (source.slice(i + 1).match(/^\d+/)?.[0].length ?? 1);
      }
      const atom = source.slice(i, atomEnd);
      i = atomEnd - 1;
      tokens.push({
        kind: "simple-token",
        source: atom,
        zeroWidth: atom === "\\b" || atom === "\\B",
        opaque: flags.includes("v") && (atom.startsWith("\\p{") || atom.startsWith("\\P{")),
        ambiguousWhenRepeated: flags.includes("v") && vPropertyMayContainStrings(atom),
        backreferenceKey: /^\\[1-9]\d*$/.test(atom)
          ? `index:${Number.parseInt(atom.slice(1), 10)}`
          : atom.startsWith("\\k<")
            ? `name:${atom.slice(3, -1)}`
            : undefined,
      });
      continue;
    }

    if (ch === "[") {
      const start = i;
      let depth = 1;
      for (i += 1; i < source.length; i += 1) {
        if (source[i] === "\\") {
          i += 1;
        } else if (flags.includes("v") && source[i] === "[") {
          depth += 1;
        } else if (source[i] === "]") {
          depth -= 1;
          if (depth === 0) {
            break;
          }
        }
      }
      const atom = source.slice(start, i + 1);
      tokens.push({
        kind: "simple-token",
        source: atom,
        zeroWidth: false,
        opaque:
          flags.includes("v") &&
          (atom.includes("\\q{") || atom.includes("\\p{") || atom.includes("\\P{")),
        ambiguousWhenRepeated:
          flags.includes("v") &&
          (vSetHasAmbiguousStrings(atom) || vPropertyMayContainStrings(atom)),
      });
      continue;
    }

    if (ch === "(") {
      let zeroWidth = false;
      let opaque = false;
      let captureKeys: string[] = [];
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
      } else {
        const modifierPrefix = source.slice(i + 1).match(/^\?[ims]*(?:-[ims]+)?:/);
        if (modifierPrefix) {
          // Scoped modifiers change atom semantics inside the group. Keep the
          // language opaque so repeated alternatives fail closed.
          opaque = true;
          i += modifierPrefix[0].length;
        } else if (shortPrefix === "?<") {
          const closing = source.indexOf(">", i + 3);
          if (closing >= 0) {
            captureIndex += 1;
            captureKeys = [`index:${captureIndex}`, `name:${source.slice(i + 3, closing)}`];
            i = closing;
          }
        } else {
          captureIndex += 1;
          captureKeys = [`index:${captureIndex}`];
        }
      }
      tokens.push({ kind: "group-open", zeroWidth, opaque, captureKeys });
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

    const atom = unicodeAware
      ? String.fromCodePoint(expectDefined(source.codePointAt(i), "pattern code point"))
      : source.charAt(i);
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
  const capturedPaths = new Map<string, string[][] | null>();

  const recordCapturedPaths = (captureKey: string, paths: string[][] | null): void => {
    if (!capturedPaths.has(captureKey)) {
      capturedPaths.set(captureKey, paths);
      return;
    }
    const existing = capturedPaths.get(captureKey);
    if (!existing || !paths) {
      capturedPaths.set(captureKey, null);
      return;
    }
    const merged = [...existing, ...paths];
    capturedPaths.set(captureKey, merged.length <= MAX_ALTERNATIVE_PATHS ? merged : null);
  };

  const emitToken = (token: TokenState) => {
    const frame = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
    frame.lastToken = token;
    if (token.containsRepetition) {
      frame.containsRepetition = true;
    }
    if (token.containsAlternation) {
      frame.containsAlternation = true;
    }
    if (token.hasAmbiguousAlternation) {
      frame.hasAmbiguousAlternation = true;
    }
    frame.branchMinLength = addLength(frame.branchMinLength, token.minLength);
    frame.branchMaxLength = addLength(frame.branchMaxLength, token.maxLength);
    if (frame.branchPaths && token.paths) {
      const tokenPaths = token.paths;
      const paths = frame.branchPaths.flatMap((left) =>
        tokenPaths.map((right) => left.concat(right)),
      );
      frame.branchPaths = paths.length <= MAX_ALTERNATIVE_PATHS ? paths : null;
    } else {
      frame.branchPaths = null;
    }
    frame.branchSignatures.push(token.signature);
  };

  const emitSimpleToken = (
    source: string,
    zeroWidth: boolean,
    opaque = false,
    ambiguousWhenRepeated = false,
  ) => {
    emitToken({
      containsRepetition: false,
      containsAlternation: false,
      hasAmbiguousAlternation: ambiguousWhenRepeated,
      minLength: zeroWidth ? 0 : 1,
      maxLength: zeroWidth ? 0 : 1,
      paths: zeroWidth ? [[]] : opaque ? null : [[source]],
      signature: source,
    });
  };

  for (const token of tokens) {
    if (token.kind === "simple-token") {
      const backreferencePaths = token.backreferenceKey
        ? capturedPaths.get(token.backreferenceKey)
        : undefined;
      if (backreferencePaths) {
        const lengths = backreferencePaths.map((path) => path.length);
        emitToken({
          containsRepetition: false,
          containsAlternation: backreferencePaths.length > 1,
          hasAmbiguousAlternation: false,
          minLength: Math.min(...lengths),
          maxLength: Math.max(...lengths),
          paths: backreferencePaths,
          signature: token.source,
        });
      } else {
        emitSimpleToken(
          token.source,
          token.zeroWidth,
          token.opaque || token.backreferenceKey !== undefined,
          token.ambiguousWhenRepeated,
        );
      }
      continue;
    }

    if (token.kind === "group-open") {
      frames.push(createParseFrame(token.zeroWidth, token.opaque, token.captureKeys));
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
        const alternativePaths = frame.alternativePaths.flatMap((paths) => paths ?? []);
        const consumingGroupPaths = frame.hasAlternation
          ? frame.alternativePaths.every((paths) => paths !== null) &&
            alternativePaths.length <= MAX_ALTERNATIVE_PATHS
            ? alternativePaths
            : null
          : frame.branchPaths;
        for (const captureKey of frame.captureKeys) {
          recordCapturedPaths(
            captureKey,
            frame.zeroWidth || frame.opaque ? null : consumingGroupPaths,
          );
        }
        emitToken({
          containsRepetition: frame.containsRepetition,
          containsAlternation: frame.containsAlternation,
          hasAmbiguousAlternation:
            frame.hasAmbiguousAlternation ||
            (frame.opaque && frame.containsAlternation) ||
            (frame.hasAlternation &&
              frame.altMinLength !== null &&
              frame.altMaxLength !== null &&
              (frame.opaque ||
                alternativesOverlap(frame.alternativePaths, flags) ||
                alternativesRepeatExactly(frame.alternativeSignatures))),
          minLength: frame.zeroWidth ? 0 : groupMinLength,
          maxLength: frame.zeroWidth ? 0 : groupMaxLength,
          paths: frame.zeroWidth ? [[]] : frame.opaque ? null : consumingGroupPaths,
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
      frame.containsAlternation = true;
      recordAlternative(frame);
      frame.branchMinLength = 0;
      frame.branchMaxLength = 0;
      frame.branchPaths = [[]];
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
    previousToken.paths = null;
    frame.containsRepetition = true;
    frame.branchPaths = null;
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
  return analyzeTokensForNestedRepetition(tokenizePattern(source, flags), flags);
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
