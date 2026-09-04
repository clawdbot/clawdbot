import type { FastMode } from "@openclaw/normalization-core/string-coerce";
// Parses inline reply directives into typed execution and routing options.
import type { QueueMode } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ExecAsk, ExecSecurity, ExecTarget } from "../../infra/exec-approvals.js";
import { extractModelDirective, type ModelSelectionScope } from "../model.js";
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
import type { QueueDropPolicy } from "./queue/types.js";

const REPLY_DIRECTIVE_COMMANDS = {
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
type ReplyDirectiveCommand = keyof typeof REPLY_DIRECTIVE_COMMANDS;

/** Resolves a registered command key without inferring directive ownership from slash text. */
export function resolveReplyDirectiveCommand(
  commandKey: string | undefined,
): ReplyDirectiveCommand | undefined {
  return commandKey && Object.hasOwn(REPLY_DIRECTIVE_COMMANDS, commandKey)
    ? (commandKey as ReplyDirectiveCommand)
    : undefined;
}

type NativeDirectiveInvocation = {
  name: ReplyDirectiveCommand;
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
  modelDirectiveSource?: "alias" | "model";
  modelScope?: ModelSelectionScope;
  modelScopeConflict: boolean;
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
export function parseInlineSessionDirectives(
  body: string,
  options?: {
    modelAliases?: string[];
    disableElevated?: boolean;
    allowStatusDirective?: boolean;
    nativeCommand?: ReplyDirectiveCommand;
  },
): InlineDirectives {
  const nativeCommand = options?.nativeCommand;
  let cleaned = body;
  let hasAnyDirective = false;
  const parseScopedDirective = <T extends { cleaned: string; hasDirective: boolean }>(
    commandName: ReplyDirectiveCommand,
    extract: (value: string) => T,
    enabled = true,
  ): T => {
    const parsed =
      enabled && (!nativeCommand || nativeCommand === commandName)
        ? extract(cleaned)
        : ({ cleaned, hasDirective: false } as T);
    cleaned = parsed.cleaned;
    hasAnyDirective ||= parsed.hasDirective;
    return parsed;
  };
  const think = parseScopedDirective("think", (value) =>
    extractThinkDirective(value, { strict: nativeCommand === "think" }),
  );
  const verbose = parseScopedDirective("verbose", (value) =>
    extractVerboseDirective(value, { strict: nativeCommand === "verbose" }),
  );
  const trace = parseScopedDirective("trace", (value) =>
    extractTraceDirective(value, { strict: nativeCommand === "trace" }),
  );
  const fast = parseScopedDirective("fast", (value) =>
    extractFastDirective(value, { strict: nativeCommand === "fast" }),
  );
  const reasoning = parseScopedDirective("reasoning", (value) =>
    extractReasoningDirective(value, { strict: nativeCommand === "reasoning" }),
  );
  const elevated = parseScopedDirective(
    "elevated",
    (value) => extractElevatedDirective(value, { strict: nativeCommand === "elevated" }),
    !options?.disableElevated,
  );
  const exec = parseScopedDirective("exec", extractExecDirective);
  const allowStatusDirective = options?.allowStatusDirective !== false && !nativeCommand;
  const { cleaned: statusCleaned, hasDirective: hasStatusDirective } = allowStatusDirective
    ? extractStatusDirective(cleaned)
    : { cleaned, hasDirective: false };
  cleaned = statusCleaned;
  hasAnyDirective ||= hasStatusDirective;
  const model = parseScopedDirective("model", (value) =>
    extractModelDirective(value, {
      aliases: options?.modelAliases,
    }),
  );
  const queue = parseScopedDirective("queue", extractQueueDirective);
  // Later directives see text cleaned by earlier directives; preserve that ordering.
  return {
    cleaned,
    ...(nativeCommand && hasAnyDirective
      ? {
          nativeCommand: {
            name: nativeCommand,
            ...(cleaned ? { unconsumedArguments: cleaned } : {}),
          },
        }
      : {}),
    hasThinkDirective: think.hasDirective,
    thinkLevel: think.thinkLevel,
    rawThinkLevel: think.rawLevel,
    clearThinkLevel: think.hasDirective && isSessionDefaultDirectiveValue(think.rawLevel),
    hasVerboseDirective: verbose.hasDirective,
    verboseLevel: verbose.verboseLevel,
    rawVerboseLevel: verbose.rawLevel,
    hasTraceDirective: trace.hasDirective,
    traceLevel: trace.traceLevel,
    rawTraceLevel: trace.rawLevel,
    hasFastDirective: fast.hasDirective,
    fastMode: fast.fastMode,
    rawFastMode: fast.rawLevel,
    clearFastMode: fast.hasDirective && isSessionDefaultDirectiveValue(fast.rawLevel),
    hasReasoningDirective: reasoning.hasDirective,
    reasoningLevel: reasoning.reasoningLevel,
    rawReasoningLevel: reasoning.rawLevel,
    hasElevatedDirective: elevated.hasDirective,
    elevatedLevel: elevated.elevatedLevel,
    rawElevatedLevel: elevated.rawLevel,
    hasExecDirective: exec.hasDirective,
    execHost: exec.execHost,
    execSecurity: exec.execSecurity,
    execAsk: exec.execAsk,
    execNode: exec.execNode,
    rawExecHost: exec.rawExecHost,
    rawExecSecurity: exec.rawExecSecurity,
    rawExecAsk: exec.rawExecAsk,
    rawExecNode: exec.rawExecNode,
    hasExecOptions: exec.hasExecOptions,
    invalidExecHost: exec.invalidHost,
    invalidExecSecurity: exec.invalidSecurity,
    invalidExecAsk: exec.invalidAsk,
    invalidExecNode: exec.invalidNode,
    hasStatusDirective,
    hasModelDirective: model.hasDirective,
    rawModelDirective: model.rawModel,
    rawModelProfile: model.rawProfile,
    rawModelRuntime: model.rawRuntime,
    modelDirectiveSource: model.source,
    modelScope: model.scope,
    modelScopeConflict: model.scopeConflict,
    hasQueueDirective: queue.hasDirective,
    queueMode: queue.queueMode,
    queueReset: queue.queueReset,
    rawQueueMode: queue.rawMode,
    debounceMs: queue.debounceMs,
    cap: queue.cap,
    dropPolicy: queue.dropPolicy,
    rawDebounce: queue.rawDebounce,
    rawCap: queue.rawCap,
    rawDrop: queue.rawDrop,
    hasQueueOptions: queue.hasOptions,
  };
}
