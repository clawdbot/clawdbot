// Performs lightweight safe-regex checks for user-supplied patterns.
import { expectDefined } from "@openclaw/normalization-core";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { alternativesOverlap, readLegacyOctalEscape } from "./safe-regex-atom-overlap.js";
import { vSetHasAmbiguousStrings } from "./safe-regex-v-set.js";

type QuantifierRead = {
  consumed: number;
  minRepeat: number;
  maxRepeat: number | null;
};

type TokenState = {
  captureKeys: string[];
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
  invalidatesCapturesOnClose: boolean;
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
  branchCaptureKeys: Set<string>;
  alternativePaths: Array<string[][] | null>;
  alternativeCaptureKeys: Array<Set<string>>;
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
  | {
      kind: "group-open";
      zeroWidth: boolean;
      opaque: boolean;
      captureKeys: string[];
      invalidatesCapturesOnClose: boolean;
    }
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
  invalidatesCapturesOnClose = false,
): ParseFrame {
  return {
    captureKeys,
    invalidatesCapturesOnClose,
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
    branchCaptureKeys: new Set(),
    alternativePaths: [],
    alternativeCaptureKeys: [],
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
  frame.alternativeCaptureKeys.push(new Set(frame.branchCaptureKeys));
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
        opaque: flags.includes("v") && vPropertyMayContainStrings(atom),
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
      let invalidatesCapturesOnClose = false;
      let captureKeys: string[] = [];
      const shortPrefix = source.slice(i + 1, i + 3);
      const longPrefix = source.slice(i + 1, i + 4);
      if (longPrefix === "?<=" || longPrefix === "?<!") {
        zeroWidth = true;
        invalidatesCapturesOnClose = longPrefix === "?<!";
        i += 3;
      } else if (shortPrefix === "?=" || shortPrefix === "?!") {
        zeroWidth = true;
        invalidatesCapturesOnClose = shortPrefix === "?!";
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
      tokens.push({
        kind: "group-open",
        zeroWidth,
        opaque,
        captureKeys,
        invalidatesCapturesOnClose,
      });
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
    for (const captureKey of token.captureKeys) {
      frame.branchCaptureKeys.add(captureKey);
    }
  };

  const emitSimpleToken = (
    source: string,
    zeroWidth: boolean,
    opaque = false,
    ambiguousWhenRepeated = false,
  ) => {
    emitToken({
      captureKeys: [],
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
      const backreferenceKey = token.backreferenceKey;
      const backreferenceMayBeUnmatched = backreferenceKey
        ? frames.some(
            (frame) =>
              frame.hasAlternation &&
              frame.alternativeCaptureKeys.some((keys) => keys.has(backreferenceKey)) &&
              !frame.branchCaptureKeys.has(backreferenceKey),
          )
        : false;
      const backreferencePaths = backreferenceKey
        ? backreferenceMayBeUnmatched
          ? null
          : capturedPaths.get(backreferenceKey)
        : undefined;
      if (backreferencePaths) {
        const lengths = backreferencePaths.map((path) => path.length);
        emitToken({
          captureKeys: [],
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
      frames.push(
        createParseFrame(
          token.zeroWidth,
          token.opaque,
          token.captureKeys,
          token.invalidatesCapturesOnClose,
        ),
      );
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
        const descendantCaptureKeys = new Set<string>();
        const captureKeySets = frame.hasAlternation
          ? frame.alternativeCaptureKeys
          : [frame.branchCaptureKeys];
        for (const captureKeys of captureKeySets) {
          for (const captureKey of captureKeys) {
            descendantCaptureKeys.add(captureKey);
          }
        }
        if (frame.hasAlternation) {
          for (const captureKey of descendantCaptureKeys) {
            if (!frame.alternativeCaptureKeys.every((keys) => keys.has(captureKey))) {
              capturedPaths.set(captureKey, null);
            }
          }
        }
        for (const captureKey of frame.captureKeys) {
          recordCapturedPaths(
            captureKey,
            frame.zeroWidth || frame.opaque ? null : consumingGroupPaths,
          );
        }
        if (frame.invalidatesCapturesOnClose) {
          for (const captureKey of descendantCaptureKeys) {
            capturedPaths.set(captureKey, null);
          }
        }
        emitToken({
          captureKeys: [...new Set([...descendantCaptureKeys, ...frame.captureKeys])],
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
      frame.branchCaptureKeys = new Set();
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
    if (token.quantifier.minRepeat === 0) {
      for (const captureKey of previousToken.captureKeys) {
        capturedPaths.set(captureKey, null);
      }
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
  pruneMapToMaxSize(safeRegexCache, SAFE_REGEX_CACHE_MAX);
  return result;
}

export function compileSafeRegex(source: string, flags = ""): RegExp | null {
  return compileSafeRegexDetailed(source, flags).regex;
}
