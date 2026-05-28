import { createHash } from "node:crypto";
import { logDebug, logError } from "../logger.js";
import { redactToolDetail } from "../logging/redact.js";
import { isPlainObject } from "../utils.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import {
  buildBlockedToolResult,
  isToolWrappedWithBeforeToolCallHook,
  isBeforeToolCallBlockedError,
  recordAdjustedParamsForToolCall,
  runBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import {
  getCodeModeExecBeforeHookMetadata,
  normalizeCodeModeExecBeforeHookParams,
  reconcileCodeModeExecBeforeHookParams,
} from "./code-mode-control-tools.js";
import { sanitizeForConsole } from "./console-sanitize.js";
import type { ClientToolDefinition } from "./embedded-agent-runner/run/params.js";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "./runtime/index.js";
import type { ToolDefinition } from "./sessions/index.js";
import { normalizeToolName } from "./tool-policy.js";
import { jsonResult, payloadTextResult } from "./tools/common.js";

type AnyAgentTool = AgentTool;

type ToolExecuteArgsCurrent = [
  string,
  unknown,
  AbortSignal | undefined,
  AgentToolUpdateCallback | undefined,
  unknown,
];
type ToolExecuteArgsLegacy = [
  string,
  unknown,
  AgentToolUpdateCallback | undefined,
  unknown,
  AbortSignal | undefined,
];
type ToolExecuteArgs = ToolDefinition["execute"] extends (...args: infer P) => unknown
  ? P
  : ToolExecuteArgsCurrent;
type ToolExecuteArgsAny = ToolExecuteArgs | ToolExecuteArgsLegacy | ToolExecuteArgsCurrent;
const TOOL_ERROR_PARAM_PREVIEW_MAX_CHARS = 600;
const TOOL_ERROR_EXEC_COMMAND_HASH_CHARS = 16;
const SENSITIVE_EXEC_ENV_VALUE = "[omitted exec env value]";
const EXEC_COMMAND_PARAM_KEYS = new Set(["command", "cmd"]);

export type ClientToolCallRecorder =
  | ((toolName: string, params: Record<string, unknown>) => void)
  | {
      reserve?: (toolCallId: string, toolName: string) => void;
      complete: (toolCallId: string, toolName: string, params: Record<string, unknown>) => void;
      discard?: (toolCallId: string, toolName: string) => void;
    };

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null && "aborted" in value;
}

function isLegacyToolExecuteArgs(args: ToolExecuteArgsAny): args is ToolExecuteArgsLegacy {
  const third = args[2];
  const fifth = args[4];
  if (typeof third === "function") {
    return true;
  }
  return isAbortSignal(fifth);
}

function describeToolExecutionError(err: unknown): {
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    const message = err.message?.trim() ? err.message : String(err);
    return { message, stack: err.stack };
  }
  return { message: String(err) };
}

function serializeToolParams(value: unknown): string {
  if (value === undefined) {
    return "<undefined>";
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === "string") {
      return serialized;
    }
  } catch {
    // Fall through to String(value).
  }
  if (typeof value === "function") {
    return value.name ? `[Function ${value.name}]` : "[Function anonymous]";
  }
  if (typeof value === "symbol") {
    return value.description ? `Symbol(${value.description})` : "Symbol()";
  }
  return Object.prototype.toString.call(value);
}

function formatToolParamPreview(label: string, value: unknown): string {
  const serialized = serializeToolParams(value);
  const redacted = redactToolDetail(serialized);
  const preview = sanitizeForConsole(redacted, TOOL_ERROR_PARAM_PREVIEW_MAX_CHARS) ?? "<empty>";
  return `${label}=${preview}`;
}

function kindForLog(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function summarizeSensitiveValueForLog(params: {
  value: unknown;
  reason: string;
}): Record<string, unknown> {
  const serialized = serializeToolParams(params.value);
  return {
    omitted: true,
    reason: params.reason,
    type: kindForLog(params.value),
    chars: serialized.length,
    sha256: createHash("sha256")
      .update(serialized)
      .digest("hex")
      .slice(0, TOOL_ERROR_EXEC_COMMAND_HASH_CHARS),
  };
}

function summarizeExecCommandForLog(command: unknown): Record<string, unknown> {
  return summarizeSensitiveValueForLog({
    value: command,
    reason: "exec command may contain credentials",
  });
}

function sanitizeExecEnvForLog(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value === undefined ? undefined : "[omitted exec env]";
  }
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, SENSITIVE_EXEC_ENV_VALUE]),
  );
}

function sanitizeExecFailureParamsForLog(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isPlainObject(parsed)) {
        return sanitizeExecFailureParamsForLog(parsed);
      }
    } catch {
      // Non-JSON exec params can still be a raw model-supplied command payload.
    }
  }
  if (!isPlainObject(value)) {
    return summarizeSensitiveValueForLog({
      value,
      reason: "exec params may contain command credentials",
    });
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (EXEC_COMMAND_PARAM_KEYS.has(key)) {
      sanitized[key] = summarizeExecCommandForLog(field);
      continue;
    }
    if (key === "env") {
      sanitized[key] = sanitizeExecEnvForLog(field);
      continue;
    }
    sanitized[key] = field;
  }
  return sanitized;
}

function sanitizeToolFailureParamsForLog(toolName: string, value: unknown): unknown {
  return toolName === "exec" ? sanitizeExecFailureParamsForLog(value) : value;
}

function describeToolFailureInputs(params: {
  toolName: string;
  rawParams: unknown;
  effectiveParams: unknown;
}): string {
  const rawParams = sanitizeToolFailureParamsForLog(params.toolName, params.rawParams);
  const effectiveParams = sanitizeToolFailureParamsForLog(params.toolName, params.effectiveParams);
  const parts = [formatToolParamPreview("raw_params", rawParams)];
  const rawSerialized = serializeToolParams(rawParams);
  const effectiveSerialized = serializeToolParams(effectiveParams);
  if (effectiveSerialized !== rawSerialized) {
    parts.push(formatToolParamPreview("effective_params", effectiveParams));
  }
  return parts.join(" ");
}

function normalizeToolExecutionResult(params: {
  toolName: string;
  result: unknown;
}): AgentToolResult<unknown> {
  const { toolName, result } = params;
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      return result as AgentToolResult<unknown>;
    }
    logDebug(`tools: ${toolName} returned non-standard result (missing content[]); coercing`);
    const details = "details" in record ? record.details : record;
    const safeDetails = details ?? { status: "ok", tool: toolName };
    return payloadTextResult(safeDetails);
  }
  const safeDetails = result ?? { status: "ok", tool: toolName };
  return payloadTextResult(safeDetails);
}

function buildToolExecutionErrorResult(params: {
  toolName: string;
  message: string;
}): AgentToolResult<unknown> {
  return jsonResult({
    status: "error",
    tool: params.toolName,
    error: params.message,
  });
}

function splitToolExecuteArgs(args: ToolExecuteArgsAny): {
  toolCallId: string;
  params: unknown;
  onUpdate: AgentToolUpdateCallback | undefined;
  signal: AbortSignal | undefined;
} {
  if (isLegacyToolExecuteArgs(args)) {
    const [toolCallId, params, onUpdate, _ctx, signal] = args;
    return {
      toolCallId,
      params,
      onUpdate,
      signal,
    };
  }
  const [toolCallId, params, signal, onUpdate] = args;
  return {
    toolCallId,
    params,
    onUpdate,
    signal,
  };
}

export const CLIENT_TOOL_NAME_CONFLICT_PREFIX = "client tool name conflict:";

export function findClientToolNameConflicts(params: {
  tools: ClientToolDefinition[];
  existingToolNames?: Iterable<string>;
}): string[] {
  const existingNormalized = new Set<string>();
  for (const name of params.existingToolNames ?? []) {
    const trimmed = name.trim();
    if (trimmed) {
      existingNormalized.add(normalizeToolName(trimmed));
    }
  }

  const conflicts = new Set<string>();
  const seenClientNames = new Map<string, string>();
  for (const tool of params.tools) {
    const rawName = (tool.function?.name ?? "").trim();
    if (!rawName) {
      continue;
    }
    const normalizedName = normalizeToolName(rawName);
    if (existingNormalized.has(normalizedName)) {
      conflicts.add(rawName);
    }
    const priorClientName = seenClientNames.get(normalizedName);
    if (priorClientName) {
      conflicts.add(priorClientName);
      conflicts.add(rawName);
      continue;
    }
    seenClientNames.set(normalizedName, rawName);
  }
  return Array.from(conflicts);
}

export function createClientToolNameConflictError(conflicts: string[]): Error {
  return new Error(`${CLIENT_TOOL_NAME_CONFLICT_PREFIX} ${conflicts.join(", ")}`);
}

export function isClientToolNameConflictError(err: unknown): err is Error {
  return err instanceof Error && err.message.startsWith(CLIENT_TOOL_NAME_CONFLICT_PREFIX);
}

export function toToolDefinitions(
  tools: AnyAgentTool[],
  hookContext?: HookContext,
): ToolDefinition[] {
  return tools.map((tool) => {
    const name = tool.name || "tool";
    const normalizedName = normalizeToolName(name);
    const beforeHookWrapped = isToolWrappedWithBeforeToolCallHook(tool);
    return {
      name,
      label: tool.label ?? name,
      description: tool.description ?? "",
      parameters: tool.parameters,
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params, onUpdate, signal } = splitToolExecuteArgs(args);
        let executeParams = params;
        try {
          if (!beforeHookWrapped) {
            const hookParams = normalizeCodeModeExecBeforeHookParams({ tool, params });
            const hookMetadata = getCodeModeExecBeforeHookMetadata({ tool, params });
            const hookOutcome = await runBeforeToolCallHook({
              toolName: name,
              params: hookParams,
              ...hookMetadata,
              toolCallId,
              ctx: hookContext,
            });
            if (hookOutcome.blocked) {
              if (hookOutcome.kind === "veto") {
                return buildBlockedToolResult({
                  reason: hookOutcome.reason,
                  deniedReason: hookOutcome.deniedReason,
                });
              }
              throw new Error(hookOutcome.reason);
            }
            executeParams = reconcileCodeModeExecBeforeHookParams({
              tool,
              originalParams: params,
              hookParams,
              adjustedParams: hookOutcome.params,
            });
            recordAdjustedParamsForToolCall(toolCallId, executeParams, hookContext?.runId);
          }
          const rawResult = await tool.execute(toolCallId, executeParams, signal, onUpdate);
          const result = normalizeToolExecutionResult({
            toolName: normalizedName,
            result: rawResult,
          });
          return result;
        } catch (err) {
          if (signal?.aborted) {
            throw err;
          }
          if (isBeforeToolCallBlockedError(err)) {
            logDebug(`tools: ${normalizedName} blocked by before_tool_call: ${err.reason}`);
            return buildBlockedToolResult({
              reason: err.reason,
            });
          }
          const described = describeToolExecutionError(err);
          if (described.stack && described.stack !== described.message) {
            logDebug(`tools: ${normalizedName} failed stack:\n${described.stack}`);
          }
          const inputPreview = describeToolFailureInputs({
            toolName: normalizedName,
            rawParams: params,
            effectiveParams: executeParams,
          });
          logError(`[tools] ${normalizedName} failed: ${described.message} ${inputPreview}`);

          return buildToolExecutionErrorResult({
            toolName: normalizedName,
            message: described.message,
          });
        }
      },
    } satisfies ToolDefinition;
  });
}

/**
 * Coerce tool-call params into a plain object.
 *
 * Some providers (e.g. Gemini) stream tool-call arguments as incremental
 * string deltas.  By the time the framework invokes the tool's `execute`
 * callback the accumulated value may still be a JSON **string** rather than
 * a parsed object.  `isPlainObject()` returns `false` for strings, which
 * caused the params to be silently replaced with `{}`.
 *
 * This helper tries `JSON.parse` when the value is a string and falls back
 * to an empty object only when parsing genuinely fails.
 */
function coerceParamsRecord(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isPlainObject(parsed)) {
          return parsed;
        }
      } catch {
        // not valid JSON – fall through to empty object
      }
    }
  }
  return {};
}

// Convert client tools (OpenResponses hosted tools) to ToolDefinition format
// These tools are intercepted to return a "pending" result instead of executing
export function toClientToolDefinitions(
  tools: ClientToolDefinition[],
  onClientToolCall?: ClientToolCallRecorder,
  hookContext?: HookContext,
): ToolDefinition[] {
  return tools.map((tool) => {
    const func = tool.function;
    return {
      name: func.name,
      label: func.name,
      description: func.description ?? "",
      parameters: func.parameters as ToolDefinition["parameters"],
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params } = splitToolExecuteArgs(args);
        if (onClientToolCall && typeof onClientToolCall !== "function") {
          onClientToolCall.reserve?.(toolCallId, func.name);
        }
        const initialParamsRecord = coerceParamsRecord(params);
        try {
          const outcome = await runBeforeToolCallHook({
            toolName: func.name,
            params: initialParamsRecord,
            toolCallId,
            ctx: hookContext,
          });
          if (outcome.blocked) {
            if (onClientToolCall && typeof onClientToolCall !== "function") {
              onClientToolCall.discard?.(toolCallId, func.name);
            }
            if (outcome.kind === "veto") {
              return buildBlockedToolResult({
                reason: outcome.reason,
                deniedReason: outcome.deniedReason,
              });
            }
            throw new Error(outcome.reason);
          }
          const adjustedParams = outcome.params;
          const paramsRecord = coerceParamsRecord(adjustedParams);
          // Notify handler that a client tool was called.
          if (onClientToolCall) {
            if (typeof onClientToolCall === "function") {
              onClientToolCall(func.name, paramsRecord);
            } else {
              onClientToolCall.complete(toolCallId, func.name, paramsRecord);
            }
          }
        } catch (err) {
          if (onClientToolCall && typeof onClientToolCall !== "function") {
            onClientToolCall.discard?.(toolCallId, func.name);
          }
          throw err;
        }
        // Return a terminal pending result; the client will execute the tool.
        return {
          ...jsonResult({
            status: "pending",
            tool: func.name,
            message: "Tool execution delegated to client",
          }),
          terminate: true,
        };
      },
    } satisfies ToolDefinition;
  });
}
