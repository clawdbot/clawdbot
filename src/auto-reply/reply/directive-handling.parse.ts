import type { FastMode } from "@openclaw/normalization-core/string-coerce";
// Parses inline reply directives into typed execution and routing options.
import type { ExecAsk, ExecSecurity, ExecTarget } from "../../infra/exec-approvals.js";
import { extractModelDirective } from "../model.js";
import { isSessionDefaultDirectiveValue } from "../thinking.js";
import type {
  ElevatedLevel,
  ReasoningLevel,
  ThinkLevel,
  TraceLevel,
  VerboseLevel,
} from "./directives.js";
import {
  extractElevatedDirective,
  extractExecDirective,
  extractFastDirective,
  extractReasoningDirective,
  extractStatusDirective,
  extractTraceDirective,
  extractThinkDirective,
  extractVerboseDirective,
} from "./directives.js";
import { extractQueueDirective } from "./queue/directive.js";
import type { QueueDropPolicy, QueueMode } from "./queue/types.js";

const NATIVE_REPLY_DIRECTIVE_COMMANDS = {
  think: true,
  verbose: true,
  trace: true,
  fast: true,
  reasoning: true,
  elevated: true,
  exec: true,
  model: true,
  queue: true,
} as const;

/** Canonical command-registry keys that share the session-directive execution pipeline. */
type NativeReplyDirectiveCommand = keyof typeof NATIVE_REPLY_DIRECTIVE_COMMANDS;

/** Resolves a registered command key without inferring directive ownership from slash text. */
export function resolveNativeReplyDirectiveCommand(
  commandKey: string | undefined,
): NativeReplyDirectiveCommand | undefined {
  return commandKey && Object.hasOwn(NATIVE_REPLY_DIRECTIVE_COMMANDS, commandKey)
    ? (commandKey as NativeReplyDirectiveCommand)
    : undefined;
}

type NativeDirectiveInvocation = {
  name: NativeReplyDirectiveCommand;
  unconsumedArguments?: string;
};

/** Parsed inline directives removed from a user message before agent execution. */
export type InlineDirectives = {
  cleaned: string;
  /** Explicit native command ownership prevents prose-oriented inline cleanup from eating args. */
  nativeCommand?: NativeDirectiveInvocation;
  hasThinkDirective: boolean;
  thinkLevel?: ThinkLevel;
  rawThinkLevel?: string;
  clearThinkLevel: boolean;
  hasVerboseDirective: boolean;
  verboseLevel?: VerboseLevel;
  rawVerboseLevel?: string;
  hasTraceDirective: boolean;
  traceLevel?: TraceLevel;
  rawTraceLevel?: string;
  hasFastDirective: boolean;
  fastMode?: FastMode;
  rawFastMode?: string;
  clearFastMode: boolean;
  hasReasoningDirective: boolean;
  reasoningLevel?: ReasoningLevel;
  rawReasoningLevel?: string;
  hasElevatedDirective: boolean;
  elevatedLevel?: ElevatedLevel;
  rawElevatedLevel?: string;
  hasExecDirective: boolean;
  execHost?: ExecTarget;
  execSecurity?: ExecSecurity;
  execAsk?: ExecAsk;
  execNode?: string;
  rawExecHost?: string;
  rawExecSecurity?: string;
  rawExecAsk?: string;
  rawExecNode?: string;
  hasExecOptions: boolean;
  invalidExecHost: boolean;
  invalidExecSecurity: boolean;
  invalidExecAsk: boolean;
  invalidExecNode: boolean;
  hasStatusDirective: boolean;
  hasModelDirective: boolean;
  rawModelDirective?: string;
  rawModelProfile?: string;
  rawModelRuntime?: string;
  hasQueueDirective: boolean;
  queueMode?: QueueMode;
  queueReset: boolean;
  rawQueueMode?: string;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
  rawDebounce?: string;
  rawCap?: string;
  rawDrop?: string;
  hasQueueOptions: boolean;
};

/** Parses supported inline directives in the same order they are stripped from text. */
export function parseInlineDirectives(
  body: string,
  options?: {
    modelAliases?: string[];
    disableElevated?: boolean;
    allowStatusDirective?: boolean;
    nativeCommand?: NativeReplyDirectiveCommand;
  },
): InlineDirectives {
  const nativeCommand = options?.nativeCommand;
  const parseScopedDirective = <T extends { cleaned: string; hasDirective: boolean }>(
    currentBody: string,
    commandName: NativeReplyDirectiveCommand,
    extract: (value: string) => T,
  ): T =>
    !nativeCommand || nativeCommand === commandName
      ? extract(currentBody)
      : ({ cleaned: currentBody, hasDirective: false } as T);
  const {
    cleaned: thinkCleaned,
    thinkLevel,
    rawLevel: rawThinkLevel,
    hasDirective: hasThinkDirective,
  } = parseScopedDirective(body, "think", (value) =>
    extractThinkDirective(value, { strict: nativeCommand === "think" }),
  );
  const {
    cleaned: verboseCleaned,
    verboseLevel,
    rawLevel: rawVerboseLevel,
    hasDirective: hasVerboseDirective,
  } = parseScopedDirective(thinkCleaned, "verbose", (value) =>
    extractVerboseDirective(value, { strict: nativeCommand === "verbose" }),
  );
  const {
    cleaned: traceCleaned,
    traceLevel,
    rawLevel: rawTraceLevel,
    hasDirective: hasTraceDirective,
  } = parseScopedDirective(verboseCleaned, "trace", (value) =>
    extractTraceDirective(value, { strict: nativeCommand === "trace" }),
  );
  const {
    cleaned: fastCleaned,
    fastMode,
    rawLevel: rawFastMode,
    hasDirective: hasFastDirective,
  } = parseScopedDirective(traceCleaned, "fast", (value) =>
    extractFastDirective(value, { strict: nativeCommand === "fast" }),
  );
  const {
    cleaned: reasoningCleaned,
    reasoningLevel,
    rawLevel: rawReasoningLevel,
    hasDirective: hasReasoningDirective,
  } = parseScopedDirective(fastCleaned, "reasoning", (value) =>
    extractReasoningDirective(value, { strict: nativeCommand === "reasoning" }),
  );
  const {
    cleaned: elevatedCleaned,
    elevatedLevel,
    rawLevel: rawElevatedLevel,
    hasDirective: hasElevatedDirective,
  } = options?.disableElevated
    ? {
        cleaned: reasoningCleaned,
        elevatedLevel: undefined,
        rawLevel: undefined,
        hasDirective: false,
      }
    : parseScopedDirective(reasoningCleaned, "elevated", (value) =>
        extractElevatedDirective(value, { strict: nativeCommand === "elevated" }),
      );
  const {
    cleaned: execCleaned,
    execHost,
    execSecurity,
    execAsk,
    execNode,
    rawExecHost,
    rawExecSecurity,
    rawExecAsk,
    rawExecNode,
    hasExecOptions,
    invalidHost: invalidExecHost,
    invalidSecurity: invalidExecSecurity,
    invalidAsk: invalidExecAsk,
    invalidNode: invalidExecNode,
    hasDirective: hasExecDirective,
  } = parseScopedDirective(elevatedCleaned, "exec", extractExecDirective);
  const allowStatusDirective = options?.allowStatusDirective !== false && !nativeCommand;
  const { cleaned: statusCleaned, hasDirective: hasStatusDirective } = allowStatusDirective
    ? extractStatusDirective(execCleaned)
    : { cleaned: execCleaned, hasDirective: false };
  const {
    cleaned: modelCleaned,
    rawModel,
    rawProfile,
    rawRuntime,
    hasDirective: hasModelDirective,
  } = parseScopedDirective(statusCleaned, "model", (value) =>
    extractModelDirective(value, {
      aliases: options?.modelAliases,
    }),
  );
  const {
    cleaned: queueCleaned,
    queueMode,
    queueReset,
    rawMode,
    debounceMs,
    cap,
    dropPolicy,
    rawDebounce,
    rawCap,
    rawDrop,
    hasDirective: hasQueueDirective,
    hasOptions: hasQueueOptions,
  } = parseScopedDirective(modelCleaned, "queue", extractQueueDirective);
  const hasAnyDirective =
    hasThinkDirective ||
    hasVerboseDirective ||
    hasTraceDirective ||
    hasFastDirective ||
    hasReasoningDirective ||
    hasElevatedDirective ||
    hasExecDirective ||
    hasStatusDirective ||
    hasModelDirective ||
    hasQueueDirective;
  // Later directives see text cleaned by earlier directives; preserve that ordering.
  return {
    cleaned: hasAnyDirective ? queueCleaned : body.trim(),
    ...(nativeCommand && hasAnyDirective
      ? {
          nativeCommand: {
            name: nativeCommand,
            ...(queueCleaned ? { unconsumedArguments: queueCleaned } : {}),
          },
        }
      : {}),
    hasThinkDirective,
    thinkLevel,
    rawThinkLevel,
    clearThinkLevel: hasThinkDirective && isSessionDefaultDirectiveValue(rawThinkLevel),
    hasVerboseDirective,
    verboseLevel,
    rawVerboseLevel,
    hasTraceDirective,
    traceLevel,
    rawTraceLevel,
    hasFastDirective,
    fastMode,
    rawFastMode,
    clearFastMode: hasFastDirective && isSessionDefaultDirectiveValue(rawFastMode),
    hasReasoningDirective,
    reasoningLevel,
    rawReasoningLevel,
    hasElevatedDirective,
    elevatedLevel,
    rawElevatedLevel,
    hasExecDirective,
    execHost,
    execSecurity,
    execAsk,
    execNode,
    rawExecHost,
    rawExecSecurity,
    rawExecAsk,
    rawExecNode,
    hasExecOptions,
    invalidExecHost,
    invalidExecSecurity,
    invalidExecAsk,
    invalidExecNode,
    hasStatusDirective,
    hasModelDirective,
    rawModelDirective: rawModel,
    rawModelProfile: rawProfile,
    rawModelRuntime: rawRuntime,
    hasQueueDirective,
    queueMode,
    queueReset,
    rawQueueMode: rawMode,
    debounceMs,
    cap,
    dropPolicy,
    rawDebounce,
    rawCap,
    rawDrop,
    hasQueueOptions,
  };
}
