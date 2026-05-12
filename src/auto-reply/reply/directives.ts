import { escapeRegExp } from "../../utils.js";
import type { NoticeLevel, ReasoningLevel, TraceLevel } from "../thinking.js";
import {
  type ElevatedLevel,
  normalizeFastMode,
  normalizeElevatedLevel,
  normalizeReasoningLevel,
  normalizeTraceLevel,
  normalizeThinkLevel,
  normalizeVerboseLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../thinking.js";

type ExtractedLevel<T> = {
  cleaned: string;
  level?: T;
  rawLevel?: string;
  hasDirective: boolean;
};

const compileDirectivePattern = (names: readonly string[], suffix = ""): RegExp => {
  const namePattern = names.map(escapeRegExp).join("|");
  return new RegExp(`(?:^|\\s)\\/(?:${namePattern})(?=$|\\s|:)${suffix}`, "i");
};

const THINK_DIRECTIVE_PATTERN = compileDirectivePattern(["thinking", "think", "t"]);
const VERBOSE_DIRECTIVE_PATTERN = compileDirectivePattern(["verbose", "v"]);
const TRACE_DIRECTIVE_PATTERN = compileDirectivePattern(["trace"]);
const FAST_DIRECTIVE_PATTERN = compileDirectivePattern(["fast"]);
const ELEVATED_DIRECTIVE_PATTERN = compileDirectivePattern(["elevated", "elev"]);
const REASONING_DIRECTIVE_PATTERN = compileDirectivePattern(["reasoning", "reason"]);
const STATUS_DIRECTIVE_PATTERN = compileDirectivePattern(["status"], `(?:\\s*:\\s*)?`);

const matchLevelDirective = (
  body: string,
  pattern: RegExp,
): { start: number; end: number; rawLevel?: string } | null => {
  const match = body.match(pattern);
  if (!match || match.index === undefined) {
    return null;
  }
  const start = match.index;
  let end = match.index + match[0].length;
  let i = end;
  while (i < body.length && /\s/.test(body[i])) {
    i += 1;
  }
  if (body[i] === ":") {
    i += 1;
    while (i < body.length && /\s/.test(body[i])) {
      i += 1;
    }
  }
  const argStart = i;
  while (i < body.length && /[A-Za-z-]/.test(body[i])) {
    i += 1;
  }
  const rawLevel = i > argStart ? body.slice(argStart, i) : undefined;
  end = i;
  return { start, end, rawLevel };
};

const extractLevelDirective = <T>(
  body: string,
  pattern: RegExp,
  normalize: (raw?: string) => T | undefined,
): ExtractedLevel<T> => {
  const match = matchLevelDirective(body, pattern);
  if (!match) {
    return { cleaned: body.trim(), hasDirective: false };
  }
  const rawLevel = match.rawLevel;
  const level = normalize(rawLevel);
  const cleaned = body
    .slice(0, match.start)
    .concat(" ")
    .concat(body.slice(match.end))
    .replace(/\s+/g, " ")
    .trim();
  return {
    cleaned,
    level,
    rawLevel,
    hasDirective: true,
  };
};

const extractSimpleDirective = (
  body: string,
  pattern: RegExp,
): { cleaned: string; hasDirective: boolean } => {
  const match = body.match(pattern);
  const cleaned = match ? body.replace(match[0], " ").replace(/\s+/g, " ").trim() : body.trim();
  return {
    cleaned,
    hasDirective: Boolean(match),
  };
};

export function extractThinkDirective(body?: string): {
  cleaned: string;
  thinkLevel?: ThinkLevel;
  rawLevel?: string;
  hasDirective: boolean;
} {
  if (!body) {
    return { cleaned: "", hasDirective: false };
  }
  const extracted = extractLevelDirective(body, THINK_DIRECTIVE_PATTERN, normalizeThinkLevel);
  return {
    cleaned: extracted.cleaned,
    thinkLevel: extracted.level,
    rawLevel: extracted.rawLevel,
    hasDirective: extracted.hasDirective,
  };
}

export function extractVerboseDirective(body?: string): {
  cleaned: string;
  verboseLevel?: VerboseLevel;
  rawLevel?: string;
  hasDirective: boolean;
} {
  if (!body) {
    return { cleaned: "", hasDirective: false };
  }
  const extracted = extractLevelDirective(body, VERBOSE_DIRECTIVE_PATTERN, normalizeVerboseLevel);
  return {
    cleaned: extracted.cleaned,
    verboseLevel: extracted.level,
    rawLevel: extracted.rawLevel,
    hasDirective: extracted.hasDirective,
  };
}

export function extractTraceDirective(body?: string): {
  cleaned: string;
  traceLevel?: TraceLevel;
  rawLevel?: string;
  hasDirective: boolean;
} {
  if (!body) {
    return { cleaned: "", hasDirective: false };
  }
  const extracted = extractLevelDirective(body, TRACE_DIRECTIVE_PATTERN, normalizeTraceLevel);
  return {
    cleaned: extracted.cleaned,
    traceLevel: extracted.level,
    rawLevel: extracted.rawLevel,
    hasDirective: extracted.hasDirective,
  };
}

export function extractFastDirective(body?: string): {
  cleaned: string;
  fastMode?: boolean;
  rawLevel?: string;
  hasDirective: boolean;
} {
  if (!body) {
    return { cleaned: "", hasDirective: false };
  }
  const extracted = extractLevelDirective(body, FAST_DIRECTIVE_PATTERN, normalizeFastMode);
  return {
    cleaned: extracted.cleaned,
    fastMode: extracted.level,
    rawLevel: extracted.rawLevel,
    hasDirective: extracted.hasDirective,
  };
}

export function extractElevatedDirective(body?: string): {
  cleaned: string;
  elevatedLevel?: ElevatedLevel;
  rawLevel?: string;
  hasDirective: boolean;
} {
  if (!body) {
    return { cleaned: "", hasDirective: false };
  }
  const extracted = extractLevelDirective(body, ELEVATED_DIRECTIVE_PATTERN, normalizeElevatedLevel);
  return {
    cleaned: extracted.cleaned,
    elevatedLevel: extracted.level,
    rawLevel: extracted.rawLevel,
    hasDirective: extracted.hasDirective,
  };
}

export function extractReasoningDirective(body?: string): {
  cleaned: string;
  reasoningLevel?: ReasoningLevel;
  rawLevel?: string;
  hasDirective: boolean;
} {
  if (!body) {
    return { cleaned: "", hasDirective: false };
  }
  const extracted = extractLevelDirective(
    body,
    REASONING_DIRECTIVE_PATTERN,
    normalizeReasoningLevel,
  );
  return {
    cleaned: extracted.cleaned,
    reasoningLevel: extracted.level,
    rawLevel: extracted.rawLevel,
    hasDirective: extracted.hasDirective,
  };
}

export function extractStatusDirective(body?: string): {
  cleaned: string;
  hasDirective: boolean;
} {
  if (!body) {
    return { cleaned: "", hasDirective: false };
  }
  return extractSimpleDirective(body, STATUS_DIRECTIVE_PATTERN);
}

export type { ElevatedLevel, NoticeLevel, ReasoningLevel, ThinkLevel, TraceLevel, VerboseLevel };
export { extractExecDirective } from "./exec/directive.js";
