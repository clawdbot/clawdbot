/**
 * Bridges OpenClaw runtime tools into Codex app-server dynamic tool specs and
 * tool-call responses.
 */
import { createHash } from "node:crypto";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  consumeAdjustedParamsForToolCall,
  consumePreExecutionBlockedToolCall,
  createAgentToolResultMiddlewareRunner,
  createCodexAppServerToolResultExtensionRunner,
  extractMessagingToolSend,
  extractMessagingToolSendResult,
  extractToolResultMediaArtifact,
  filterToolResultMediaUrls,
  finalizeToolTerminalPresentation,
  formatToolExecutionErrorMessage,
  getBeforeToolCallFailureDisposition,
  HEARTBEAT_RESPONSE_TOOL_NAME,
  embeddedAgentLog,
  getChannelAgentToolMeta,
  getPluginToolMeta,
  getPluginToolSideEffectOwnerKey,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  isDeliveredMessageToolOnlySourceReplyResult,
  isDeliveredMessagingToolResult,
  isReplaySafeToolCall,
  isToolWrappedWithBeforeToolCallHook,
  isToolResultError,
  isMessagingTool,
  isMessagingToolSendAction,
  normalizeHeartbeatToolResponse,
  projectRuntimeToolInputSchema,
  resolveToolExecutionErrorKind,
  resolveToolResultFailureKind,
  runAgentHarnessAfterToolCallHook,
  sanitizeToolResult,
  setBeforeToolCallDiagnosticsEnabled,
  type AnyAgentTool,
  type HeartbeatToolResponse,
  type MessagingToolSend,
  type MessagingToolSourceReplyPayload,
  type ToolResultFailureKind,
  wrapToolWithBeforeToolCallHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import type { ImageContent, TextContent } from "openclaw/plugin-sdk/llm";
import { normalizeOpenAIToolSchemas } from "openclaw/plugin-sdk/provider-tools";
import {
  asNonArrayRecord,
  asOptionalRecord,
  isRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
  estimateToolResultTextChars,
  resolveLiveToolResultMaxChars,
  sliceToolResultTextToBudget,
} from "openclaw/plugin-sdk/text-utility-runtime";
import type { CodexDynamicToolsLoading } from "./config.js";
import {
  createFailedDynamicToolResponse,
  type CodexDynamicToolRuntimeResponse,
  withDynamicToolExecutionState,
  withDynamicToolTranscriptDetails,
} from "./dynamic-tool-response-state.js";
import { invalidInlineImageText, sanitizeInlineImageDataUrl } from "./image-payload-sanitizer.js";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type CodexDynamicToolCallOutputContentItem,
  type CodexDynamicToolCallParams,
  type CodexDynamicToolCallResponse,
  type CodexDynamicToolDiagnosticTerminalType,
  type CodexDynamicToolFunctionSpec,
  type CodexDynamicToolSpec,
  type JsonValue,
} from "./protocol.js";
import {
  prepareCodexRemoteWorkspaceMessageMedia,
  type CodexRemoteWorkspaceFileReader,
} from "./remote-workspace-media.js";
import { resolveCodexToolAbortTerminalReason } from "./tool-abort-terminal-reason.js";

type CodexDynamicToolHookContext = NonNullable<
  Parameters<typeof wrapToolWithBeforeToolCallHook>[1]
> & {
  remoteWorkspaceRoot?: string;
  remoteWorkspaceRequestTimeoutMs?: number;
  currentChannelProvider?: string;
  contextWindowTokens?: number;
  currentChannelId?: string;
  currentMessagingTarget?: string;
  currentMessageId?: string | number;
  currentThreadId?: string;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
  sourceReplyDeliveryMode?: EmbeddedRunAttemptParams["sourceReplyDeliveryMode"];
};

type CodexToolResultHookContext = Omit<CodexDynamicToolHookContext, "config">;

type ProjectedCodexDynamicTool = {
  tool: AnyAgentTool;
  name: string;
  description: string;
  inputSchema: JsonSchemaObject & JsonValue;
};

type CodexDynamicToolSchemaQuarantine = {
  tool: string;
  violations: readonly string[];
};

const INTERNAL_TOOL_EXECUTION_VALIDATION = Symbol.for("openclaw.internalToolExecutionValidation");
const MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERRORS = 4;
const MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERROR_CHARS = 160;
const CODEX_DYNAMIC_TOOL_VALIDATION_TRUNCATED_SUFFIX = " [detail truncated]";

function shouldValidateCodexDynamicToolInput(tool: AnyAgentTool): boolean {
  return getPluginToolMeta(tool)?.mcp?.operation !== "tool";
}

function assertCodexDynamicToolInputMatchesSchema(params: {
  toolName: string;
  schema: JsonSchemaObject;
  value: unknown;
}): void {
  const validation = validateJsonSchemaValue({
    schema: params.schema,
    cacheKey: `codex-dynamic-tool-input:${params.toolName}:${JSON.stringify(params.schema)}`,
    value: params.value,
  });
  if (validation.ok) {
    return;
  }
  const visibleErrors = validation.errors.slice(0, MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERRORS);
  const details = visibleErrors
    .map((error) => {
      if (error.text.length <= MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERROR_CHARS) {
        return error.text;
      }
      return `${error.text.slice(
        0,
        MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERROR_CHARS -
          CODEX_DYNAMIC_TOOL_VALIDATION_TRUNCATED_SUFFIX.length,
      )}${CODEX_DYNAMIC_TOOL_VALIDATION_TRUNCATED_SUFFIX}`;
    })
    .join("; ");
  const omitted = validation.errors.length - visibleErrors.length;
  const omittedSuffix = omitted > 0 ? `; ${omitted} more violation(s) omitted` : "";
  throw new Error(`Invalid arguments for tool "${params.toolName}": ${details}${omittedSuffix}.`);
}

function createCodexDynamicToolValidationControl(params: {
  toolCallId: string;
  validate: (value: unknown) => void;
}): Record<PropertyKey, unknown> {
  return {
    [INTERNAL_TOOL_EXECUTION_VALIDATION]: true,
    toolCallId: params.toolCallId,
    validate: params.validate,
  };
}

function applyCurrentMessageProvider(
  toolName: string,
  args: Record<string, unknown>,
  currentProvider: string | undefined,
): Record<string, unknown> {
  const hasProvider =
    typeof args.provider === "string" && args.provider.trim().length > 0
      ? true
      : typeof args.channel === "string" && args.channel.trim().length > 0;
  const provider = currentProvider?.trim();
  if (toolName !== "message" || hasProvider || !provider) {
    return args;
  }
  return { ...args, provider };
}

function normalizeRouteToken(value: string | number | undefined): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function sourceRouteTokens(hookContext: CodexDynamicToolHookContext | undefined): Set<string> {
  const tokens = new Set<string>();
  const currentTarget = normalizeRouteToken(hookContext?.currentMessagingTarget);
  const currentChannel = normalizeRouteToken(hookContext?.currentChannelId);
  const currentProvider = normalizeRouteToken(hookContext?.currentChannelProvider);
  if (currentTarget) {
    tokens.add(currentTarget);
  }
  if (currentChannel) {
    tokens.add(currentChannel);
  }
  const channelPrefixIndex = currentChannel?.indexOf(":") ?? -1;
  if (channelPrefixIndex >= 0 && currentChannel) {
    const unprefixedChannel = currentChannel.slice(channelPrefixIndex + 1);
    if (unprefixedChannel) {
      tokens.add(unprefixedChannel);
      for (const segment of unprefixedChannel.split(/[;,]/u)) {
        const token = normalizeRouteToken(segment);
        if (token) {
          tokens.add(token);
        }
      }
    }
  }
  if (currentProvider && currentChannel?.startsWith(`${currentProvider}:`)) {
    const unprefixedChannel = currentChannel.slice(currentProvider.length + 1);
    if (unprefixedChannel) {
      tokens.add(unprefixedChannel);
    }
  }
  return tokens;
}

function routeTokenMatchesSource(
  token: string | undefined,
  hookContext: CodexDynamicToolHookContext | undefined,
): boolean {
  const normalized = normalizeRouteToken(token);
  return normalized !== undefined && sourceRouteTokens(hookContext).has(normalized);
}

function routeProviderMatchesSource(
  provider: string | undefined,
  hookContext: CodexDynamicToolHookContext | undefined,
): boolean {
  const normalized = normalizeRouteToken(provider);
  if (!normalized) {
    return false;
  }
  const currentProvider = normalizeRouteToken(hookContext?.currentChannelProvider);
  const currentChannel = normalizeRouteToken(hookContext?.currentChannelId);
  return currentProvider === normalized || currentChannel?.startsWith(`${normalized}:`) === true;
}

function routeTokenMatchesCurrentMessage(
  token: string | number | undefined,
  hookContext: CodexDynamicToolHookContext | undefined,
): boolean {
  const normalized = normalizeRouteToken(token);
  return (
    normalized !== undefined && normalized === normalizeRouteToken(hookContext?.currentMessageId)
  );
}

function readRouteToken(record: Record<string, unknown>, key: string): string | number | undefined {
  const value = record[key];
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function explicitRouteTokensMismatchCurrent(
  args: Record<string, unknown>,
  keys: readonly string[],
  currentToken: string | number | undefined,
): boolean {
  const normalizedCurrent = normalizeRouteToken(currentToken);
  if (!normalizedCurrent) {
    return false;
  }
  return keys.some((key) => {
    const normalized = normalizeRouteToken(readRouteToken(args, key));
    return normalized !== undefined && normalized !== normalizedCurrent;
  });
}

function explicitThreadRouteTargetsNonSource(
  args: Record<string, unknown>,
  hookContext: CodexDynamicToolHookContext | undefined,
  messagingTarget: MessagingToolSend | undefined,
): boolean {
  const normalizedCurrentThread = normalizeRouteToken(hookContext?.currentThreadId);
  const explicitThreadTokens = [
    ...EXPLICIT_MESSAGE_THREAD_KEYS.map((key) => normalizeRouteToken(readRouteToken(args, key))),
    normalizeRouteToken(messagingTarget?.threadId),
  ].filter((value): value is string => value !== undefined);

  if (explicitThreadTokens.length === 0) {
    return false;
  }
  return (
    normalizedCurrentThread === undefined ||
    explicitThreadTokens.some((value) => value !== normalizedCurrentThread)
  );
}

function replyReceiptMatchesCurrentMessage(
  value: unknown,
  hookContext: CodexDynamicToolHookContext | undefined,
  depth = 0,
): boolean {
  if (depth > 4 || value === null) {
    return false;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || !["{", "["].includes(trimmed[0] ?? "")) {
      return false;
    }
    try {
      return replyReceiptMatchesCurrentMessage(JSON.parse(trimmed), hookContext, depth + 1);
    } catch {
      return false;
    }
  }
  if (typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => replyReceiptMatchesCurrentMessage(item, hookContext, depth + 1));
  }
  const record = value as Record<string, unknown>;
  for (const key of ["repliedTo", "replyTo", "replyToId", "replyToIdFull"]) {
    if (
      routeTokenMatchesCurrentMessage(
        typeof record[key] === "string" ? record[key] : undefined,
        hookContext,
      )
    ) {
      return true;
    }
  }
  for (const key of [
    "content",
    "details",
    "payload",
    "receipt",
    "result",
    "results",
    "sendResult",
    "text",
  ]) {
    if (replyReceiptMatchesCurrentMessage(record[key], hookContext, depth + 1)) {
      return true;
    }
  }
  return false;
}

function hasExplicitNonSourceMessageRoute(
  args: Record<string, unknown>,
  hookContext: CodexDynamicToolHookContext | undefined,
  messagingTarget: MessagingToolSend | undefined,
): boolean {
  const currentProvider = normalizeRouteToken(hookContext?.currentChannelProvider);
  for (const key of EXPLICIT_MESSAGE_PROVIDER_KEYS) {
    const provider = normalizeRouteToken(typeof args[key] === "string" ? args[key] : undefined);
    if (
      provider &&
      currentProvider !== provider &&
      !routeProviderMatchesSource(provider, hookContext)
    ) {
      return true;
    }
  }
  const targetValues = [
    ...EXPLICIT_MESSAGE_TARGET_KEYS.map((key) =>
      typeof args[key] === "string" ? args[key] : undefined,
    ),
    ...(Array.isArray(args.targets)
      ? args.targets.map((value) => (typeof value === "string" ? value : undefined))
      : []),
  ].filter((value): value is string => normalizeRouteToken(value) !== undefined);
  if (explicitThreadRouteTargetsNonSource(args, hookContext, messagingTarget)) {
    return true;
  }
  if (
    explicitRouteTokensMismatchCurrent(
      args,
      EXPLICIT_MESSAGE_REPLY_KEYS,
      hookContext?.currentMessageId,
    )
  ) {
    return true;
  }
  if (
    messagingTarget?.to !== undefined &&
    !routeTokenMatchesSource(messagingTarget.to, hookContext)
  ) {
    return true;
  }
  if (messagingTarget?.to !== undefined) {
    return false;
  }
  if (targetValues.length === 0) {
    return false;
  }
  if (targetValues.some((value) => !routeTokenMatchesSource(value, hookContext))) {
    return true;
  }
  return false;
}

/** Runtime bridge returned to Codex app-server attempt code. */
export type CodexDynamicToolBridge = {
  /** Final executable tools after schema projection and hook-wrapper quarantine. */
  availableTools: AnyAgentTool[];
  availableSpecs: CodexDynamicToolSpec[];
  specs: CodexDynamicToolSpec[];
  resultContentSourceForTool: (toolName: string) => AnyAgentTool["resultContentSource"];
  sideEffectOwnerKeyForTool: (toolName: string) => string | undefined;
  handleToolCall: (
    params: CodexDynamicToolCallParams,
    options?: {
      signal?: AbortSignal;
      onAgentToolResult?: EmbeddedRunAttemptParams["onAgentToolResult"];
      toolCallOrdinal?: number;
      retainExecutionSnapshot?: boolean;
    },
  ) => Promise<CodexDynamicToolRuntimeResponse>;
  /** Consume exact boundary evidence retained while post-execution processing is incomplete. */
  consumeToolExecutionSnapshot?: (
    toolCallId: string,
  ) => { executedArguments: Record<string, unknown>; executionStarted: boolean } | undefined;
  /** Bind the authenticated app-server client once remote thread startup completes. */
  setRemoteWorkspaceFileReader?: (reader: CodexRemoteWorkspaceFileReader) => void;
  telemetry: {
    didSendViaMessagingTool: boolean;
    didDeliverSourceReplyViaMessageTool: boolean;
    messagingToolSentTexts: string[];
    messagingToolSentMediaUrls: string[];
    messagingToolSentTargets: MessagingToolSend[];
    messagingToolSourceReplyPayloads: MessagingToolSourceReplyPayload[];
    heartbeatToolResponse?: HeartbeatToolResponse;
    toolMediaUrls: string[];
    toolAudioAsVoice: boolean;
    successfulCronAdds?: number;
    acceptedSessionSpawns: Array<{ runId: string; childSessionKey: string }>;
    quarantinedTools: CodexDynamicToolSchemaQuarantine[];
  };
};

function normalizeAcceptedSessionSpawn(result: unknown): {
  runId: string;
  childSessionKey: string;
} | null {
  const details = asOptionalRecord(asOptionalRecord(result)?.details);
  if (!details || details.status !== "accepted") {
    return null;
  }
  const runId = normalizeOptionalString(details.runId);
  const childSessionKey = normalizeOptionalString(details.childSessionKey);
  return runId && childSessionKey ? { runId, childSessionKey } : null;
}

/** Namespace attached to OpenClaw-owned dynamic tools exposed to Codex. */
export const CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE = "openclaw";
// Mirrors codex-rs/app-server/src/request_processors/thread_processor.rs
// (DYNAMIC_TOOL_NAME_MAX_LEN / DYNAMIC_TOOL_IDENTIFIER_PATTERN).
const CODEX_DYNAMIC_TOOL_NAME_MAX_CHARS = 128;
const CODEX_DYNAMIC_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/u;

// Keep OpenClaw control-path tools directly callable even when Codex tool_search
// is unavailable or resolves a connector-only universe. Developer instructions
// still steer normal Codex subagents to native spawn_agent.
// sessions_yield is normally routed by its catalogMode "direct-only" before
// this set is consulted; the name entry stays as the metadata-independent
// contract that control-path tools remain directly callable.
const ALWAYS_DIRECT_DYNAMIC_TOOL_NAMES = new Set([
  "agents_list",
  "sessions_spawn",
  "sessions_yield",
]);
const EXPLICIT_MESSAGE_PROVIDER_KEYS = ["channel", "provider"];
const EXPLICIT_MESSAGE_TARGET_KEYS = ["target", "to", "channelId"];
const EXPLICIT_MESSAGE_THREAD_KEYS = ["threadId", "thread_id", "messageThreadId", "topicId"];
const EXPLICIT_MESSAGE_REPLY_KEYS = ["replyTo", "replyToId", "replyToIdFull"];

function computerFrameImageIdentity(
  content: AgentToolResult<unknown>["content"] | undefined,
): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const images = content.filter((block): block is ImageContent => block.type === "image");
  if (images.length !== 1) {
    return undefined;
  }
  const image = expectDefined(images[0], "single Codex computer frame image");
  return createHash("sha256")
    .update(JSON.stringify([image.mimeType, image.data]))
    .digest("hex");
}

function invalidateComputerFrame(contextEpoch: {
  value: number;
  frameToolCallId?: string;
  frameImageIdentity?: string;
}): void {
  contextEpoch.value += 1;
  delete contextEpoch.frameToolCallId;
  delete contextEpoch.frameImageIdentity;
}

/**
 * Creates dynamic tool specs and a call handler that executes OpenClaw tools,
 * applies hooks/middleware, and records delivery/media telemetry.
 */
export function createCodexDynamicToolBridge(params: {
  tools: AnyAgentTool[];
  registeredTools?: AnyAgentTool[];
  signal: AbortSignal;
  computerContextEpoch?: {
    value: number;
    frameToolCallId?: string;
    frameImageIdentity?: string;
  };
  hookContext?: CodexDynamicToolHookContext;
  loading?: CodexDynamicToolsLoading;
  directToolNames?: Iterable<string>;
}): CodexDynamicToolBridge {
  const toolResultHookContext = toToolResultHookContext(params.hookContext);
  const contextWindowTokens = params.hookContext?.contextWindowTokens;
  const toolResultMaxChars =
    typeof contextWindowTokens === "number" &&
    Number.isFinite(contextWindowTokens) &&
    contextWindowTokens > 0
      ? Math.max(1, resolveLiveToolResultMaxChars({ contextWindowTokens }))
      : DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS;
  const availableProjection = projectCodexExecutableDynamicToolSurface(
    params.tools,
    params.hookContext,
  );
  const registeredProjection = params.registeredTools
    ? projectCodexDynamicTools(params.registeredTools)
    : availableProjection;
  const availableTools = availableProjection.tools;
  const quarantinedAvailableToolNames = new Set(
    availableProjection.quarantinedTools.map((tool) => tool.tool),
  );
  const registeredSpecTools = (
    params.registeredTools ? registeredProjection.tools : availableTools
  ).filter((entry) => !quarantinedAvailableToolNames.has(entry.name));
  const toolMap = new Map(availableTools.map((entry) => [entry.name, entry]));
  const registeredToolNames = new Set(registeredSpecTools.map((entry) => entry.name));
  const quarantinedTools = dedupeQuarantinedDynamicTools([
    ...availableProjection.quarantinedTools,
    ...registeredProjection.quarantinedTools,
  ]);
  warnQuarantinedDynamicTools({
    tools: quarantinedTools,
    availableToolCount: availableTools.length,
    registeredToolCount: registeredSpecTools.length,
  });
  emitQuarantinedDynamicToolDiagnostics(quarantinedTools, params.hookContext);
  const telemetry: CodexDynamicToolBridge["telemetry"] = {
    didSendViaMessagingTool: false,
    didDeliverSourceReplyViaMessageTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSourceReplyPayloads: [],
    toolMediaUrls: [],
    toolAudioAsVoice: false,
    acceptedSessionSpawns: [],
    quarantinedTools,
  };
  const middlewareRunner = createAgentToolResultMiddlewareRunner({
    runtime: "codex",
    ...toolResultHookContext,
  });
  const isReplaySafeToolInstance = (tool: AnyAgentTool): boolean => {
    const pluginMeta = getPluginToolMeta(tool);
    if (pluginMeta) {
      return pluginMeta.replaySafe === true;
    }
    return getChannelAgentToolMeta(tool as never) === undefined;
  };
  const legacyExtensionRunner =
    createCodexAppServerToolResultExtensionRunner(toolResultHookContext);
  type ExecutionSnapshot = {
    executedArguments: Record<string, unknown>;
    executionStarted: boolean;
  };
  type ExecutionSnapshotState = {
    consumed: boolean;
    retainAfterCompletion: boolean;
    snapshot?: ExecutionSnapshot;
  };
  const executionSnapshotStates = new Map<string, ExecutionSnapshotState>();
  const directToolNames = new Set([
    ...ALWAYS_DIRECT_DYNAMIC_TOOL_NAMES,
    ...(params.directToolNames ?? []),
  ]);
  let readRemoteWorkspaceFile: CodexRemoteWorkspaceFileReader | undefined;
  return {
    availableTools: availableTools.map((entry) => entry.tool),
    availableSpecs: createCodexDynamicToolSpecs({
      entries: availableTools,
      loading: params.loading ?? "searchable",
      directToolNames,
    }),
    specs: createCodexDynamicToolSpecs({
      entries: registeredSpecTools,
      loading: params.loading ?? "searchable",
      directToolNames,
    }),
    resultContentSourceForTool: (toolName) => toolMap.get(toolName)?.tool.resultContentSource,
    sideEffectOwnerKeyForTool: (toolName) => {
      const tool = toolMap.get(toolName)?.tool;
      return tool ? getPluginToolSideEffectOwnerKey(tool) : undefined;
    },
    telemetry,
    setRemoteWorkspaceFileReader: (reader) => {
      readRemoteWorkspaceFile = reader;
    },
    consumeToolExecutionSnapshot: (toolCallId) => {
      const state = executionSnapshotStates.get(toolCallId);
      executionSnapshotStates.delete(toolCallId);
      if (state) {
        state.consumed = true;
      }
      return state?.snapshot;
    },
    handleToolCall: async (call, options) => {
      const toolEntry = toolMap.get(call.tool);
      if (!toolEntry) {
        const executedArguments = asNonArrayRecord(call.arguments);
        const message = registeredToolNames.has(call.tool)
          ? `OpenClaw tool is not available for this turn: ${call.tool}`
          : `Unknown OpenClaw tool: ${call.tool}`;
        finalizeToolTerminalPresentation({
          toolCallId: call.callId,
          runId: toolResultHookContext.runId,
          result: failedToolResult(message),
          isError: true,
          observer: params.hookContext?.onToolOutcome,
          toolName: call.tool,
          toolCallOrdinal: options?.toolCallOrdinal,
        });
        notifyAgentToolResult(
          options?.onAgentToolResult,
          call.tool,
          failedToolResult(message),
          true,
        );
        return createFailedDynamicToolResponse(message, {
          executedArguments,
          executionStarted: false,
        });
      }
      const { tool, name: toolName } = toolEntry;
      const rawArguments = call.arguments;
      const args = asNonArrayRecord(rawArguments);
      const startedAt = Date.now();
      const signal = composeAbortSignals(params.signal, options?.signal);
      let didStartExecution = false;
      let didDispatchExecution = false;
      let executionPrevented = false;
      let executedArgs = structuredClone(args);
      const executionSnapshotState: ExecutionSnapshotState = {
        consumed: false,
        retainAfterCompletion: options?.retainExecutionSnapshot === true,
      };
      executionSnapshotStates.set(call.callId, executionSnapshotState);
      const captureExecutionBoundary = () => {
        didStartExecution ||= didDispatchExecution;
        executionPrevented =
          executionPrevented ||
          consumePreExecutionBlockedToolCall(call.callId, toolResultHookContext.runId);
        const adjustedExecutedArgs = consumeAdjustedParamsForToolCall(
          call.callId,
          toolResultHookContext.runId,
        );
        if (isRecord(adjustedExecutedArgs)) {
          executedArgs = adjustedExecutedArgs;
        }
        // Consumption detaches this invocation from the bridge map immediately. The
        // closure-local flag prevents late completion from republishing stale evidence.
        if (!executionSnapshotState.consumed) {
          executionSnapshotState.snapshot = {
            executedArguments: structuredClone(executedArgs),
            executionStarted: didStartExecution && !executionPrevented,
          };
        }
      };
      try {
        // Compatibility preparation owns raw arguments; record coercion must not run first.
        const prepare = tool.prepareArguments;
        const toolArgs = prepare ? Reflect.apply(prepare, tool, [rawArguments]) : args;
        const preparedArgs =
          toolName === "message" && isRecord(toolArgs)
            ? await prepareCodexRemoteWorkspaceMessageMedia({
                args: toolArgs,
                localWorkspaceRoot: params.hookContext?.workspaceDir,
                remoteWorkspaceRoot: params.hookContext?.remoteWorkspaceRoot,
                readRemoteFile: readRemoteWorkspaceFile,
                timeoutMs: params.hookContext?.remoteWorkspaceRequestTimeoutMs,
                signal,
              })
            : toolArgs;
        const preparedToolArgs = isRecord(preparedArgs) ? preparedArgs : args;
        executedArgs = structuredClone(preparedToolArgs);
        const messagingContext = {
          config: params.hookContext?.config,
          currentChannelId: params.hookContext?.currentChannelId,
          currentMessagingTarget: params.hookContext?.currentMessagingTarget,
          currentThreadId: params.hookContext?.currentThreadId,
          replyToMode: params.hookContext?.replyToMode,
          hasRepliedRef: params.hookContext?.hasRepliedRef
            ? { value: params.hookContext.hasRepliedRef.value }
            : undefined,
        };
        didDispatchExecution = true;
        const executionArgs: unknown[] = [call.callId, preparedArgs, signal];
        if (shouldValidateCodexDynamicToolInput(tool)) {
          executionArgs.push(
            createCodexDynamicToolValidationControl({
              toolCallId: call.callId,
              validate: (value) =>
                assertCodexDynamicToolInputMatchesSchema({
                  toolName,
                  schema: toolEntry.inputSchema,
                  value,
                }),
            }),
          );
        }
        const rawResult = await Reflect.apply(tool.execute, tool, executionArgs);
        captureExecutionBoundary();
        const telemetryRawResult = sanitizeToolResult(rawResult);
        const rawIsError = isToolResultError(rawResult);
        const rawResultFailureKind = resolveToolResultFailureKind(rawResult);
        // The native agentToolResultMiddleware runner observes OpenClaw's
        // executed args (preparedToolArgs merged with before_tool_call
        // adjustments), matching the after_tool_call hook view. The legacy
        // codex app-server extension runner keeps its historical contract of
        // observing the tool's prepared call args, before before_tool_call
        // rewrites them. Feeding the merged view to the legacy runner makes a
        // contract extension's args diverge from the invoked call, so its
        // assertion throws and its transformed result is silently discarded.
        const middlewareResult = await middlewareRunner.applyToolResultMiddleware({
          threadId: call.threadId,
          turnId: call.turnId,
          toolCallId: call.callId,
          toolName,
          args: structuredClone(executedArgs),
          isError: rawIsError,
          result: rawResult,
        });
        const result = await legacyExtensionRunner.applyToolResultExtensions({
          threadId: call.threadId,
          turnId: call.turnId,
          toolCallId: call.callId,
          toolName,
          args: structuredClone(preparedToolArgs),
          result: middlewareResult,
        });
        const resultIsError = rawIsError || isToolResultError(result);
        // A successful spawn is durable before presentation middleware can rewrite details.
        const acceptedSessionSpawn =
          toolName === "sessions_spawn" && !rawIsError
            ? normalizeAcceptedSessionSpawn(telemetryRawResult)
            : null;
        if (acceptedSessionSpawn) {
          telemetry.acceptedSessionSpawns.push(acceptedSessionSpawn);
        }
        const finalResultFailureKind = resolveToolResultFailureKind(result);
        const resultFailureKind = rawResultFailureKind ?? finalResultFailureKind;
        const observerResult =
          rawResultFailureKind && finalResultFailureKind !== rawResultFailureKind
            ? {
                ...result,
                details: {
                  ...(isRecord(result.details) ? result.details : {}),
                  status: rawResultFailureKind,
                },
              }
            : result;
        notifyAgentToolResult(options?.onAgentToolResult, toolName, observerResult, resultIsError);
        void runAgentHarnessAfterToolCallHook({
          toolName,
          toolCallId: call.callId,
          runId: toolResultHookContext.runId,
          agentId: toolResultHookContext.agentId,
          sessionId: toolResultHookContext.sessionId,
          sessionKey: toolResultHookContext.sessionKey,
          channelId: toolResultHookContext.channelId,
          startArgs: executedArgs,
          result,
          startedAt,
        });
        finalizeToolTerminalPresentation({
          toolCallId: call.callId,
          runId: toolResultHookContext.runId,
          result,
          isError: resultIsError,
          observer: params.hookContext?.onToolOutcome,
          toolName,
          toolCallOrdinal: options?.toolCallOrdinal,
        });
        const messagingTelemetryArgs = applyCurrentMessageProvider(
          toolName,
          executedArgs,
          params.hookContext?.currentChannelProvider,
        );
        const messagingTarget = isMessagingTool(toolName)
          ? extractMessagingToolSend(toolName, messagingTelemetryArgs, messagingContext)
          : undefined;
        const confirmedMessagingTarget =
          !rawIsError && messagingTarget
            ? extractMessagingToolSendResult(messagingTarget, telemetryRawResult)
            : messagingTarget;
        const terminalType =
          resultFailureKind === "blocked" ? "blocked" : resultIsError ? "error" : "completed";
        const contentItems = convertToolContents(result.content, toolResultMaxChars);
        const deliveredFrameImages = contentItems.filter((item) => item.type === "inputImage");
        const finalFrameImageIdentity = computerFrameImageIdentity(result.content);
        if (
          toolName === "computer" &&
          params.computerContextEpoch?.frameToolCallId === call.callId &&
          (deliveredFrameImages.length !== 1 ||
            finalFrameImageIdentity === undefined ||
            finalFrameImageIdentity !== params.computerContextEpoch.frameImageIdentity)
        ) {
          // Middleware may replace screenshots; retain coordinates only for exact frame bytes.
          invalidateComputerFrame(params.computerContextEpoch);
        }
        const response = withDiagnosticTerminalType(
          {
            contentItems,
            success: !resultIsError,
          },
          terminalType,
        );
        withDynamicToolTranscriptDetails(
          response,
          asOptionalRecord(sanitizeToolResult(result))?.details,
        );
        withDiagnosticFailureDisposition(response, resultFailureKind);
        const blocksSourceReplyTermination = hasExplicitNonSourceMessageRoute(
          executedArgs,
          params.hookContext,
          confirmedMessagingTarget,
        );
        const deliveredSourceReply = isDeliveredMessageToolOnlySourceReplyResult({
          sourceReplyDeliveryMode: params.hookContext?.sourceReplyDeliveryMode,
          toolName,
          args: executedArgs,
          result,
          hookResult: rawResult,
          isError: resultIsError,
          allowExplicitSourceRoute: !blocksSourceReplyTermination,
        });
        const receiptConfirmedSourceReply =
          params.hookContext?.sourceReplyDeliveryMode === "message_tool_only" &&
          toolName === "message" &&
          normalizeRouteToken(
            typeof executedArgs.action === "string" ? executedArgs.action : undefined,
          ) === "reply" &&
          !resultIsError &&
          !blocksSourceReplyTermination &&
          isDeliveredMessagingToolResult({
            toolName,
            args: executedArgs,
            result,
            hookResult: rawResult,
            isError: resultIsError,
          }) &&
          (replyReceiptMatchesCurrentMessage(rawResult, params.hookContext) ||
            replyReceiptMatchesCurrentMessage(result, params.hookContext));
        const toolConfirmedSourceReply =
          params.hookContext?.sourceReplyDeliveryMode === "message_tool_only" &&
          toolName === "message" &&
          !resultIsError &&
          (rawResult.terminate === true || result.terminate === true);
        const confirmedSourceReply =
          params.hookContext?.sourceReplyDeliveryMode === "message_tool_only" &&
          toolName === "message" &&
          (toolConfirmedSourceReply || deliveredSourceReply || receiptConfirmedSourceReply);
        const sourceReplyFinal = confirmedSourceReply ? executedArgs.final !== false : undefined;
        collectToolTelemetry({
          toolName,
          args: executedArgs,
          result,
          mediaTrustResult: telemetryRawResult,
          telemetry,
          isError: resultIsError,
          messagingTarget: confirmedMessagingTarget,
          sourceReplyFinal,
        });
        if (deliveredSourceReply || receiptConfirmedSourceReply || toolConfirmedSourceReply) {
          telemetry.didDeliverSourceReplyViaMessageTool = true;
        }
        const continuesSourceReplyProgress = confirmedSourceReply && sourceReplyFinal === false;
        withDynamicToolTermination(
          response,
          ((rawResult.terminate === true || result.terminate === true) &&
            !continuesSourceReplyProgress) ||
            // Yield is an explicit owner-level turn handoff, not termination
            // inferred from source-reply delivery, so finality does not mask it.
            isToolResultYield(rawResult) ||
            isToolResultYield(result) ||
            (confirmedSourceReply && sourceReplyFinal === true),
        );
        const asyncStarted =
          isAsyncStartedToolResult(rawResult) || isAsyncStartedToolResult(result);
        withDynamicToolAsyncStarted(response, asyncStarted);
        const replaySafe =
          executionPrevented ||
          (!asyncStarted &&
            isReplaySafeToolInstance(toolEntry.tool) &&
            isReplaySafeToolCall(toolName, executedArgs));
        return withDynamicToolExecutionState(response, {
          executedArguments: executedArgs,
          executionStarted: didStartExecution && !executionPrevented,
          sideEffectEvidence: !replaySafe,
        });
      } catch (error) {
        // Post-processing can fail after a successful body. Boundary evidence
        // is monotonic, so a second observer must never erase an earlier start.
        captureExecutionBoundary();
        if (
          toolName === "computer" &&
          params.computerContextEpoch?.frameToolCallId === call.callId
        ) {
          // Post-processing can fail after arming; retain only frames Codex received.
          invalidateComputerFrame(params.computerContextEpoch);
        }
        const beforeToolCallDisposition = getBeforeToolCallFailureDisposition(error);
        const executionDisposition =
          beforeToolCallDisposition ??
          (signal.aborted
            ? resolveCodexToolAbortTerminalReason(signal)
            : resolveToolExecutionErrorKind(error));
        const errorMessage = formatToolExecutionErrorMessage(
          error,
          "OpenClaw dynamic tool call failed.",
        );
        executionPrevented =
          executionPrevented ||
          consumePreExecutionBlockedToolCall(call.callId, toolResultHookContext.runId);
        const failedResult = failedToolResult(errorMessage, executionDisposition);
        finalizeToolTerminalPresentation({
          toolCallId: call.callId,
          runId: toolResultHookContext.runId,
          result: failedResult,
          isError: true,
          observer: params.hookContext?.onToolOutcome,
          toolName,
          toolCallOrdinal: options?.toolCallOrdinal,
        });
        notifyAgentToolResult(options?.onAgentToolResult, toolName, failedResult, true);
        collectToolTelemetry({
          toolName,
          args: executedArgs,
          result: undefined,
          telemetry,
          isError: true,
        });
        void runAgentHarnessAfterToolCallHook({
          toolName,
          toolCallId: call.callId,
          runId: toolResultHookContext.runId,
          agentId: toolResultHookContext.agentId,
          sessionId: toolResultHookContext.sessionId,
          sessionKey: toolResultHookContext.sessionKey,
          channelId: toolResultHookContext.channelId,
          startArgs: executedArgs,
          error: errorMessage,
          startedAt,
        });
        const replaySafe =
          !didStartExecution ||
          executionPrevented ||
          (isReplaySafeToolInstance(toolEntry.tool) &&
            isReplaySafeToolCall(toolName, executedArgs));
        return withDynamicToolExecutionState(
          withDiagnosticFailureDisposition(
            {
              contentItems: [
                {
                  type: "inputText",
                  text: errorMessage,
                },
              ],
              success: false,
            },
            executionDisposition,
          ),
          {
            executedArguments: executedArgs,
            executionStarted: didStartExecution && !executionPrevented,
            sideEffectEvidence: didStartExecution && !replaySafe,
          },
        );
      } finally {
        if (
          executionSnapshotStates.get(call.callId) === executionSnapshotState &&
          (executionSnapshotState.consumed || !executionSnapshotState.retainAfterCompletion)
        ) {
          executionSnapshotStates.delete(call.callId);
        }
        consumeAdjustedParamsForToolCall(call.callId, toolResultHookContext.runId);
      }
    },
  };
}

function projectCodexExecutableDynamicToolSurface(
  tools: readonly AnyAgentTool[],
  hookContext: CodexDynamicToolHookContext | undefined,
): {
  tools: ProjectedCodexDynamicTool[];
  quarantinedTools: CodexDynamicToolSchemaQuarantine[];
} {
  const projected = projectCodexDynamicTools(tools);
  const wrapped = wrapProjectedCodexDynamicTools(projected.tools, hookContext);
  return {
    tools: wrapped.tools,
    quarantinedTools: dedupeQuarantinedDynamicTools([
      ...projected.quarantinedTools,
      ...wrapped.quarantinedTools,
    ]),
  };
}

/** Applies the exact schema and hook-wrapper projection used by the executable Codex bridge. */
export function projectCodexExecutableDynamicTools(params: {
  tools: readonly AnyAgentTool[];
  hookContext?: CodexDynamicToolHookContext;
}): {
  availableTools: AnyAgentTool[];
  quarantinedTools: CodexDynamicToolSchemaQuarantine[];
} {
  const projected = projectCodexExecutableDynamicToolSurface(params.tools, params.hookContext);
  return {
    availableTools: projected.tools.map((entry) => entry.tool),
    quarantinedTools: projected.quarantinedTools,
  };
}

function notifyAgentToolResult(
  observer: EmbeddedRunAttemptParams["onAgentToolResult"] | undefined,
  toolName: string,
  result: unknown,
  isError: boolean,
) {
  try {
    observer?.({
      toolName,
      result: sanitizeToolResult(result),
      isError,
    });
  } catch (error) {
    embeddedAgentLog.warn(
      `onAgentToolResult handler failed: tool=${toolName} error=${String(error)}`,
    );
  }
}

function failedToolResult(
  message: string,
  status: ToolResultFailureKind = "failed",
): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: message }],
    details: { status, error: message },
  };
}

function wrapProjectedCodexDynamicTools(
  tools: readonly ProjectedCodexDynamicTool[],
  hookContext: CodexDynamicToolHookContext | undefined,
): {
  tools: ProjectedCodexDynamicTool[];
  quarantinedTools: CodexDynamicToolSchemaQuarantine[];
} {
  const wrappedTools: ProjectedCodexDynamicTool[] = [];
  const quarantinedTools: CodexDynamicToolSchemaQuarantine[] = [];
  for (const entry of tools) {
    try {
      if (isToolWrappedWithBeforeToolCallHook(entry.tool)) {
        setBeforeToolCallDiagnosticsEnabled(entry.tool, false);
        wrappedTools.push(entry);
        continue;
      }
      wrappedTools.push({
        ...entry,
        tool: wrapToolWithBeforeToolCallHook(entry.tool, hookContext, {
          emitDiagnostics: false,
        }),
      });
    } catch {
      quarantinedTools.push({
        tool: entry.name,
        violations: [`${entry.name} could not be wrapped for before-tool-call hooks`],
      });
    }
  }
  return { tools: wrappedTools, quarantinedTools };
}

function createCodexDynamicToolSpecs(params: {
  entries: readonly ProjectedCodexDynamicTool[];
  loading: CodexDynamicToolsLoading;
  directToolNames: ReadonlySet<string>;
}): CodexDynamicToolSpec[] {
  const specs: CodexDynamicToolSpec[] = [];
  const namespaceTools: CodexDynamicToolFunctionSpec[] = [];
  const directOnlyNamespaceTools: CodexDynamicToolFunctionSpec[] = [];
  // Codex reuses its incremental websocket request only when the complete
  // searchable surface is unchanged. Direct mode retains its compatibility order.
  const entries =
    params.loading === "direct"
      ? params.entries
      : params.entries.toSorted((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const functionSpec = createCodexDynamicToolFunctionSpec({ entry });
    if (entry.name === "openclaw" && params.directToolNames.has(entry.name)) {
      // OpenClaw is ring-zero and its whole turn surface. Keep its canonical
      // root name even though generic direct-only tools use a model namespace.
      specs.push(functionSpec);
      continue;
    }
    if (entry.tool.catalogMode === "direct-only") {
      directOnlyNamespaceTools.push(functionSpec);
      continue;
    }
    if (params.loading === "direct" || params.directToolNames.has(entry.name)) {
      specs.push(functionSpec);
      continue;
    }
    namespaceTools.push({ ...functionSpec, deferLoading: true });
  }
  if (namespaceTools.length > 0) {
    specs.push({
      type: "namespace",
      name: CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
      description: "",
      tools: namespaceTools,
    });
  }
  if (directOnlyNamespaceTools.length > 0) {
    specs.push({
      type: "namespace",
      name: CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
      description: "",
      tools: directOnlyNamespaceTools,
    });
  }
  return specs;
}

function createCodexDynamicToolFunctionSpec(params: {
  entry: ProjectedCodexDynamicTool;
}): CodexDynamicToolFunctionSpec {
  return {
    type: "function",
    name: params.entry.name,
    description: params.entry.description,
    inputSchema: params.entry.inputSchema,
  };
}

function projectCodexDynamicTools(tools: readonly AnyAgentTool[]): {
  tools: ProjectedCodexDynamicTool[];
  quarantinedTools: CodexDynamicToolSchemaQuarantine[];
} {
  const projectedTools: ProjectedCodexDynamicTool[] = [];
  const quarantinedTools: CodexDynamicToolSchemaQuarantine[] = [];
  let length: number;
  try {
    length = tools.length;
  } catch {
    return {
      tools: [],
      quarantinedTools: [{ tool: "tool[0]", violations: ["tool[0] is unreadable"] }],
    };
  }
  for (let toolIndex = 0; toolIndex < length; toolIndex += 1) {
    let tool: AnyAgentTool;
    try {
      tool = tools[toolIndex]!;
    } catch {
      quarantinedTools.push({
        tool: `tool[${toolIndex}]`,
        violations: [`tool[${toolIndex}] is unreadable`],
      });
      continue;
    }
    const descriptor = readCodexDynamicToolDescriptor(tool, toolIndex);
    if (!descriptor.ok) {
      quarantinedTools.push(descriptor.diagnostic);
      continue;
    }
    const normalizedParameters = normalizeOpenAIToolSchemas({
      provider: "openai",
      modelApi: "openai-chatgpt-responses",
      // The shared normalizer only reads parameters; do not expose unreadable plugin fields.
      tools: [{ parameters: descriptor.parameters } as AnyAgentTool],
    })[0]?.parameters;
    const projection = projectRuntimeToolInputSchema(
      normalizedParameters ?? descriptor.parameters,
      `${descriptor.name}.inputSchema`,
    );
    if (projection.violations.length > 0) {
      quarantinedTools.push({ tool: descriptor.name, violations: projection.violations });
      continue;
    }
    if (!isRecord(projection.schema)) {
      quarantinedTools.push({
        tool: descriptor.name,
        violations: [`${descriptor.name}.inputSchema must be a JSON object schema`],
      });
      continue;
    }
    projectedTools.push({
      tool,
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: projection.schema,
    });
  }
  return { tools: projectedTools, quarantinedTools };
}

type CodexDynamicToolDescriptorRead =
  | {
      ok: true;
      name: string;
      description: string;
      parameters: unknown;
    }
  | {
      ok: false;
      diagnostic: CodexDynamicToolSchemaQuarantine;
    };

function readCodexDynamicToolDescriptor(
  tool: AnyAgentTool,
  toolIndex: number,
): CodexDynamicToolDescriptorRead {
  const fallbackName = `tool[${toolIndex}]`;
  let name: string;
  try {
    const rawName = tool.name;
    if (typeof rawName !== "string" || !rawName) {
      return {
        ok: false,
        diagnostic: {
          tool: fallbackName,
          violations: [`${fallbackName}.name must be a non-empty string`],
        },
      };
    }
    const trimmedName = rawName.trim();
    let nameViolation: string | undefined;
    if (!trimmedName) {
      nameViolation = `${rawName}.name must not be empty`;
    } else if (trimmedName !== rawName) {
      nameViolation = `${rawName}.name must not have leading or trailing whitespace`;
    } else if (!CODEX_DYNAMIC_TOOL_NAME_PATTERN.test(rawName)) {
      nameViolation = `${rawName}.name must match ^[a-zA-Z0-9_-]+$`;
    } else if (rawName.length > CODEX_DYNAMIC_TOOL_NAME_MAX_CHARS) {
      nameViolation = `${rawName}.name must be at most ${CODEX_DYNAMIC_TOOL_NAME_MAX_CHARS} characters`;
    } else if (rawName === "mcp" || rawName.startsWith("mcp__")) {
      nameViolation = `${rawName}.name is reserved by Codex app-server`;
    }
    if (nameViolation) {
      return {
        ok: false,
        diagnostic: {
          tool: rawName,
          violations: [nameViolation],
        },
      };
    }
    name = rawName;
  } catch {
    return {
      ok: false,
      diagnostic: {
        tool: fallbackName,
        violations: [`${fallbackName}.name is unreadable`],
      },
    };
  }
  let description: string;
  try {
    description = typeof tool.description === "string" ? tool.description : "";
  } catch {
    return {
      ok: false,
      diagnostic: {
        tool: name,
        violations: [`${name}.description is unreadable`],
      },
    };
  }
  let parameters: unknown;
  try {
    parameters = tool.parameters;
  } catch {
    return {
      ok: false,
      diagnostic: {
        tool: name,
        violations: [`${name}.inputSchema is unreadable`],
      },
    };
  }
  return { ok: true, name, description, parameters };
}

function warnQuarantinedDynamicTools(params: {
  tools: readonly CodexDynamicToolSchemaQuarantine[];
  availableToolCount: number;
  registeredToolCount: number;
}): void {
  if (params.tools.length === 0) {
    return;
  }
  const unique = new Map<string, readonly string[]>();
  for (const tool of params.tools) {
    unique.set(tool.tool, tool.violations);
  }
  embeddedAgentLog.warn(
    `codex app-server quarantined ${unique.size} unsupported dynamic tool ${unique.size === 1 ? "definition" : "definitions"}: ${[...unique.keys()].join(", ")}; retained ${params.availableToolCount} available and ${params.registeredToolCount} registered tools`,
    {
      tools: [...unique.entries()].map(([tool, violations]) => ({ tool, violations })),
      availableToolCount: params.availableToolCount,
      registeredToolCount: params.registeredToolCount,
    },
  );
}

function emitQuarantinedDynamicToolDiagnostics(
  tools: readonly CodexDynamicToolSchemaQuarantine[],
  ctx: CodexDynamicToolHookContext | undefined,
): void {
  for (const tool of tools) {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.blocked",
      agentId: ctx?.agentId,
      runId: ctx?.runId,
      sessionId: ctx?.sessionId,
      sessionKey: ctx?.sessionKey,
      toolName: tool.tool,
      deniedReason: "unsupported_tool_schema",
      reason: tool.violations.join(", "),
    });
  }
}

function dedupeQuarantinedDynamicTools(
  tools: readonly CodexDynamicToolSchemaQuarantine[],
): CodexDynamicToolSchemaQuarantine[] {
  return [
    ...new Map(
      tools.map((tool) => [
        tool.tool,
        {
          tool: tool.tool,
          violations: tool.violations,
        },
      ]),
    ).values(),
  ];
}
function toToolResultHookContext(
  ctx: CodexDynamicToolHookContext | undefined,
): CodexToolResultHookContext {
  const { agentId, sessionId, sessionKey, runId, channelId } = ctx ?? {};
  return {
    ...(agentId && { agentId }),
    ...(sessionId && { sessionId }),
    ...(sessionKey && { sessionKey }),
    ...(runId && { runId }),
    ...(channelId && { channelId }),
  };
}

function composeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length === 0) {
    return new AbortController().signal;
  }
  if (activeSignals.length === 1) {
    return expectDefined(activeSignals[0], "single active Codex abort signal");
  }
  return AbortSignal.any(activeSignals);
}
function collectToolTelemetry(params: {
  toolName: string;
  args: Record<string, unknown>;
  result: AgentToolResult<unknown> | undefined;
  mediaTrustResult?: unknown;
  telemetry: CodexDynamicToolBridge["telemetry"];
  isError: boolean;
  messagingTarget?: MessagingToolSend;
  sourceReplyFinal?: boolean;
}): MessagingToolSend | MessagingToolSourceReplyPayload | undefined {
  if (params.isError) {
    return undefined;
  }
  if (!params.isError && params.toolName === "cron" && isCronAddAction(params.args)) {
    params.telemetry.successfulCronAdds = (params.telemetry.successfulCronAdds ?? 0) + 1;
  }
  if (!params.isError && params.toolName === HEARTBEAT_RESPONSE_TOOL_NAME) {
    const response = normalizeHeartbeatToolResponse(params.result?.details);
    if (response) {
      params.telemetry.heartbeatToolResponse = response;
    }
  }
  if (!params.isError && params.result) {
    const media = extractToolResultMediaArtifact(params.result);
    if (media) {
      const mediaUrls = filterToolResultMediaUrls(
        params.toolName,
        media.mediaUrls,
        params.mediaTrustResult ?? params.result,
      );
      const seen = new Set(params.telemetry.toolMediaUrls);
      for (const mediaUrl of mediaUrls) {
        if (!seen.has(mediaUrl)) {
          seen.add(mediaUrl);
          params.telemetry.toolMediaUrls.push(mediaUrl);
        }
      }
      if (media.audioAsVoice) {
        params.telemetry.toolAudioAsVoice = true;
      }
    }
  }
  if (!isMessagingTool(params.toolName)) {
    return undefined;
  }
  const isMessagingSendAction = isMessagingToolSendAction(params.toolName, params.args);
  if (!isMessagingSendAction && !params.messagingTarget) {
    return undefined;
  }
  if (
    !isMessagingSendAction &&
    !isDeliveredMessagingToolResult({
      toolName: params.toolName,
      args: params.args,
      result: params.result,
      hookResult: params.mediaTrustResult,
      isError: params.isError,
    })
  ) {
    return undefined;
  }
  params.telemetry.didSendViaMessagingTool = true;
  const sourceReplyPayload = extractInternalSourceReplyPayload(params.result?.details);
  if (sourceReplyPayload) {
    const record = {
      ...sourceReplyPayload,
      ...(params.sourceReplyFinal !== undefined
        ? { sourceReplyFinal: params.sourceReplyFinal }
        : {}),
    };
    params.telemetry.messagingToolSourceReplyPayloads.push(record);
    return record;
  }
  const text = readFirstString(params.args, ["text", "message", "body", "content"]);
  if (text) {
    params.telemetry.messagingToolSentTexts.push(text);
  }
  const mediaUrls = collectMediaUrls(params.args);
  params.telemetry.messagingToolSentMediaUrls.push(...mediaUrls);
  const record = {
    ...(params.messagingTarget ?? {
      tool: params.toolName,
      provider: readFirstString(params.args, ["provider", "channel"]) ?? params.toolName,
      accountId: readFirstString(params.args, ["accountId", "account_id"]),
      to: readFirstString(params.args, ["to", "target", "recipient"]),
      threadId: readFirstString(params.args, ["threadId", "thread_id", "messageThreadId"]),
    }),
    ...(text ? { text } : {}),
    ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
    ...(params.sourceReplyFinal !== undefined ? { sourceReplyFinal: params.sourceReplyFinal } : {}),
  };
  params.telemetry.messagingToolSentTargets.push(record);
  return record;
}
function extractInternalSourceReplyPayload(
  details: unknown,
): MessagingToolSourceReplyPayload | undefined {
  if (!isRecord(details) || details.sourceReplySink !== "internal-ui") {
    return undefined;
  }
  const rawPayload = details.sourceReply;
  if (!isRecord(rawPayload)) {
    return undefined;
  }
  const text = readFirstString(rawPayload, ["text", "message"]);
  const mediaUrls = collectMediaUrls(rawPayload);
  const mediaUrl =
    typeof rawPayload.mediaUrl === "string" && rawPayload.mediaUrl.trim()
      ? rawPayload.mediaUrl.trim()
      : mediaUrls[0];
  const payload: MessagingToolSourceReplyPayload = {
    ...(text ? { text } : {}),
    ...(mediaUrl ? { mediaUrl } : {}),
    ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
    ...(rawPayload.audioAsVoice === true ? { audioAsVoice: true } : {}),
    ...(isRecord(rawPayload.presentation)
      ? { presentation: rawPayload.presentation as never }
      : {}),
    ...(isRecord(rawPayload.interactive) ? { interactive: rawPayload.interactive as never } : {}),
    ...(isRecord(rawPayload.channelData) ? { channelData: rawPayload.channelData } : {}),
    ...(typeof details.idempotencyKey === "string" && details.idempotencyKey.trim()
      ? { idempotencyKey: details.idempotencyKey.trim() }
      : {}),
  };
  return text || mediaUrls.length > 0 || payload.presentation || payload.interactive
    ? payload
    : undefined;
}
function isToolResultYield(result: AgentToolResult<unknown>): boolean {
  const details = result.details;
  if (!isRecord(details) || typeof details.status !== "string") {
    return false;
  }
  return details.status.trim().toLowerCase() === "yielded";
}
function isAsyncStartedToolResult(result: AgentToolResult<unknown>): boolean {
  const details = result.details;
  return isRecord(details) && details.async === true && details.status === "started";
}
function withDiagnosticTerminalType<T extends CodexDynamicToolCallResponse>(
  response: T,
  terminalType: CodexDynamicToolDiagnosticTerminalType,
): T {
  Object.defineProperty(response, "diagnosticTerminalType", {
    configurable: true,
    enumerable: false,
    value: terminalType,
  });
  return response;
}
function withDiagnosticFailureDisposition<T extends CodexDynamicToolCallResponse>(
  response: T,
  disposition: ToolResultFailureKind | undefined,
): T {
  if (!disposition) {
    return response;
  }
  withDiagnosticTerminalType(response, disposition === "blocked" ? "blocked" : "error");
  if (disposition !== "blocked") {
    Object.defineProperty(response, "diagnosticTerminalReason", {
      configurable: true,
      enumerable: false,
      value: disposition,
    });
  }
  return response;
}
function withDynamicToolTermination<T extends CodexDynamicToolCallResponse>(
  response: T,
  terminate: boolean,
): T {
  if (!terminate) {
    return response;
  }
  Object.defineProperty(response, "terminate", {
    configurable: true,
    enumerable: false,
    value: true,
  });
  return response;
}
function withDynamicToolAsyncStarted<T extends CodexDynamicToolCallResponse>(
  response: T,
  asyncStarted: boolean,
): T {
  if (!asyncStarted) {
    return response;
  }
  Object.defineProperty(response, "asyncStarted", {
    configurable: true,
    enumerable: false,
    value: true,
  });
  return response;
}
function normalizeToolResultMaxChars(maxChars: number): number {
  return typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0
    ? Math.floor(maxChars)
    : DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS;
}
function convertToolContents(
  content: Array<TextContent | ImageContent>,
  toolResultMaxChars = DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
): CodexDynamicToolCallOutputContentItem[] {
  const maxChars = normalizeToolResultMaxChars(toolResultMaxChars);
  const totalTextChars = content.reduce(
    (total, item) => total + (item.type === "text" ? item.text.length : 0),
    0,
  );
  const totalTextBudget = content.reduce(
    (total, item) => total + (item.type === "text" ? estimateToolResultTextChars(item.text) : 0),
    0,
  );
  if (totalTextBudget <= maxChars) {
    return content.flatMap(convertToolContent);
  }
  const noticeText = `...(OpenClaw truncated dynamic tool result: original ${totalTextChars} chars, weighted budget ${maxChars}; rerun with narrower args.)`;
  const notice = `\n${noticeText}`;
  const noticeChars = estimateToolResultTextChars(notice);
  const textBudget = Math.max(0, maxChars - noticeChars);
  let remainingTextBudget = textBudget;
  let appendedNotice = false;
  const output: CodexDynamicToolCallOutputContentItem[] = [];
  for (const item of content) {
    if (item.type !== "text") {
      output.push(...convertToolContent(item));
      continue;
    }
    if (appendedNotice) {
      continue;
    }
    if (noticeChars >= maxChars) {
      output.push({ type: "inputText", text: sliceToolResultTextToBudget(noticeText, maxChars) });
      appendedNotice = true;
      continue;
    }
    const text = sliceToolResultTextToBudget(item.text, remainingTextBudget);
    remainingTextBudget -= estimateToolResultTextChars(text);
    const shouldAppendNotice = remainingTextBudget <= 0 || text.length < item.text.length;
    if (shouldAppendNotice) {
      // The notice budget is reserved before slicing text, so the combined
      // result is already bounded without another boundary-sensitive cut.
      output.push({ type: "inputText", text: `${text.trimEnd()}${notice}` });
      appendedNotice = true;
    } else if (text.length > 0) {
      output.push({ type: "inputText", text });
    }
  }
  if (!appendedNotice) {
    output.push({ type: "inputText", text: sliceToolResultTextToBudget(noticeText, maxChars) });
  }
  return output;
}
function convertToolContent(
  content: TextContent | ImageContent,
): CodexDynamicToolCallOutputContentItem[] {
  if (content.type === "text") {
    return [{ type: "inputText", text: content.text }];
  }
  const imageUrl = sanitizeInlineImageDataUrl(`data:${content.mimeType};base64,${content.data}`);
  if (!imageUrl) {
    return [{ type: "inputText", text: invalidInlineImageText("codex dynamic tool") }];
  }
  return [
    {
      type: "inputImage",
      imageUrl,
    },
  ];
}
function readFirstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}
function collectMediaUrls(record: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const pushMediaUrl = (value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      urls.push(value.trim());
    }
  };
  const pushAttachment = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return;
    }
    const attachment = value as Record<string, unknown>;
    for (const key of ["media", "mediaUrl", "path", "filePath", "fileUrl", "url"]) {
      pushMediaUrl(attachment[key]);
    }
  };
  for (const key of [
    "media",
    "mediaUrl",
    "media_url",
    "path",
    "filePath",
    "fileUrl",
    "imageUrl",
    "image_url",
  ]) {
    const value = record[key];
    pushMediaUrl(value);
  }
  for (const key of ["mediaUrls", "media_urls", "imageUrls", "image_urls"]) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      pushMediaUrl(entry);
    }
  }
  const attachments = record.attachments;
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      pushAttachment(attachment);
    }
  }
  return urls;
}
function isCronAddAction(args: Record<string, unknown>): boolean {
  const action = args.action;
  return typeof action === "string" && action.trim().toLowerCase() === "add";
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
