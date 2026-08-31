// Defines reply directive parsing constants and text-matching helpers.
import { escapeRegExp } from "../../utils.js";
import {
  type ReasoningLevel,
  type TraceLevel,
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
import { removeDirectiveSpan, skipDirectiveArgPrefix } from "./directive-parsing.js";

type ExtractedLevel<T> = {
  cleaned: string;
  level?: T;
  rawLevel?: string;
  hasDirective: boolean;
};

type LevelDirectiveParseOptions = {
  strict?: boolean;
};

const compileDirectivePattern = (names: readonly string[]): RegExp => {
  const namePattern = names.map(escapeRegExp).join("|");
  return new RegExp(`(?<!\\S)\\/(?:${namePattern})(?=$|\\s|:)`, "i");
};

const matchLevelDirective = (
  body: string,
  pattern: RegExp,
  normalize: (raw?: string) => unknown,
  options?: LevelDirectiveParseOptions,
): { start: number; end: number; rawLevel?: string } | null => {
  const match = body.match(pattern);
  if (!match || match.index === undefined) {
    return null;
  }
  const start = match.index;
  const directiveEnd = match.index + match[0].length;
  const prefixEnd = directiveEnd + skipDirectiveArgPrefix(body.slice(directiveEnd));
  let i = prefixEnd;
  while (i < body.length && /\s/.test(body.charAt(i))) {
    i += 1;
  }
  const argStart = i;
  while (
    i < body.length &&
    (options?.strict ? !/\s/.test(body.charAt(i)) : /[A-Za-z-]/.test(body.charAt(i)))
  ) {
    i += 1;
  }
  const candidate = i > argStart ? body.slice(argStart, i) : undefined;
  if (
    candidate !== undefined &&
    (options?.strict || normalize(candidate) !== undefined || body.slice(i).trim().length === 0)
  ) {
    return { start, end: i, rawLevel: candidate };
  }
  return { start, end: prefixEnd };
};

const extractLevelDirective = <T>(
  body: string,
  pattern: RegExp,
  normalize: (raw?: string) => T | undefined,
  options?: LevelDirectiveParseOptions,
): ExtractedLevel<T> => {
  const match = matchLevelDirective(body, pattern, normalize, options);
  if (!match) {
    return { cleaned: body, hasDirective: false };
  }
  const rawLevel = match.rawLevel;
  const level = normalize(rawLevel);
  const cleaned = removeDirectiveSpan(body, match.start, match.end);
  return {
    cleaned,
    level,
    rawLevel,
    hasDirective: true,
  };
};

type NamedLevelDirective<T, Field extends string> = Omit<ExtractedLevel<T>, "level"> & {
  [Key in Field]?: T;
};

function createLevelDirectiveExtractor<T, Field extends string>(
  names: readonly string[],
  field: Field,
  normalize: (raw?: string) => T | undefined,
): (body?: string, options?: LevelDirectiveParseOptions) => NamedLevelDirective<T, Field> {
  const pattern = compileDirectivePattern(names);
  return (body, options) => {
    if (!body) {
      return { cleaned: "", hasDirective: false } as NamedLevelDirective<T, Field>;
    }
    const { cleaned, level, rawLevel, hasDirective } = extractLevelDirective(
      body,
      pattern,
      normalize,
      options,
    );
    return { cleaned, [field]: level, rawLevel, hasDirective } as NamedLevelDirective<T, Field>;
  };
}

export const extractThinkDirective = createLevelDirectiveExtractor(
  ["thinking", "think", "t"],
  "thinkLevel",
  normalizeThinkLevel,
);
export const extractVerboseDirective = createLevelDirectiveExtractor(
  ["verbose", "v"],
  "verboseLevel",
  normalizeVerboseLevel,
);
export const extractTraceDirective = createLevelDirectiveExtractor(
  ["trace"],
  "traceLevel",
  normalizeTraceLevel,
);
export const extractFastDirective = createLevelDirectiveExtractor(
  ["fast"],
  "fastMode",
  normalizeFastMode,
);
export const extractElevatedDirective = createLevelDirectiveExtractor(
  ["elevated", "elev"],
  "elevatedLevel",
  normalizeElevatedLevel,
);
export const extractReasoningDirective = createLevelDirectiveExtractor(
  ["reasoning", "reason"],
  "reasoningLevel",
  normalizeReasoningLevel,
);

export type { ElevatedLevel, ReasoningLevel, ThinkLevel, TraceLevel, VerboseLevel };
export { extractExecDirective } from "./exec/directive.js";
export { extractStatusDirective } from "./reply-inline.js";
