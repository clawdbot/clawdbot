import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  createAgentToolResultMiddlewareRunner,
  createCodexAppServerToolResultExtensionRunner,
  extractToolResultMediaArtifact,
  filterToolResultMediaUrls,
  HEARTBEAT_RESPONSE_TOOL_NAME,
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
  isToolWrappedWithBeforeToolCallHook,
  isMessagingTool,
  isMessagingToolSendAction,
  normalizeHeartbeatToolResponse,
  projectRuntimeToolInputSchema,
  runAgentHarnessAfterToolCallHook,
  setBeforeToolCallDiagnosticsEnabled,
  type AnyAgentTool,
  type HeartbeatToolResponse,
  type MessagingToolSend,
  type MessagingToolSourceReplyPayload,
  wrapToolWithBeforeToolCallHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { ImageContent, TextContent } from "openclaw/plugin-sdk/llm";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  asOptionalRecord as readRecord,
  isRecord,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexDynamicToolsLoading } from "./config.js";
import { invalidInlineImageText, sanitizeInlineImageDataUrl } from "./image-payload-sanitizer.js";
import type {
  CodexDynamicToolCallOutputContentItem,
  CodexDynamicToolCallParams,
  CodexDynamicToolCallResponse,
  CodexDynamicToolDiagnosticTerminalType,
  CodexDynamicToolSpec,
  JsonValue,
} from "./protocol.js";

type CodexDynamicToolHookContext = {
  agentId?: string;
  config?: EmbeddedRunAttemptParams["config"];
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  channelId?: string;
};

type CodexToolResultHookContext = Omit<CodexDynamicToolHookContext, "config">;

type ProjectedCodexDynamicTool = {
  tool: AnyAgentTool;
  inputSchema: JsonValue;
};

type CodexDynamicToolSchemaQuarantine = {
  tool: string;
  violations: readonly string[];
};

export type CodexDynamicToolBridge = {
  availableSpecs: CodexDynamicToolSpec[];
  specs: CodexDynamicToolSpec[];
  handleToolCall: (
    params: CodexDynamicToolCallParams,
    options?: { signal?: AbortSignal },
  ) => Promise<CodexDynamicToolCallResponse>;
  telemetry: {
    didSendViaMessagingTool: boolean;
    messagingToolSentTexts: string[];
    messagingToolSentMediaUrls: string[];
    messagingToolSentTargets: MessagingToolSend[];
    messagingToolSourceReplyPayloads: MessagingToolSourceReplyPayload[];
    heartbeatToolResponse?: HeartbeatToolResponse;
    toolMediaUrls: string[];
    toolAudioAsVoice: boolean;
    successfulCronAdds?: number;
    quarantinedTools: CodexDynamicToolSchemaQuarantine[];
  };
};

export const CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE = "openclaw";

// Keep OpenClaw session spawning searchable in Codex mode so Codex's native
// spawn_agent remains the primary Codex subagent surface.
const ALWAYS_DIRECT_DYNAMIC_TOOL_NAMES = new Set(["sessions_yield"]);
const DEFAULT_CODEX_DYNAMIC_TOOL_RESULT_MAX_CHARS = 16_000;

export function createCodexDynamicToolBridge(params: {
  tools: AnyAgentTool[];
  registeredTools?: AnyAgentTool[];
  signal: AbortSignal;
  hookContext?: CodexDynamicToolHookContext;
  loading?: CodexDynamicToolsLoading;
  directToolNames?: Iterable<string>;
}): CodexDynamicToolBridge {
  const toolResultHookContext = toToolResultHookContext(params.hookContext);
  const toolResultMaxChars = resolveCodexDynamicToolResultMaxChars(params.hookContext);
  const availableProjection = projectCodexDynamicTools(params.tools);
  const registeredProjection = params.registeredTools
    ? projectCodexDynamicTools(params.registeredTools)
    : availableProjection;
  const availableTools = availableProjection.tools.map(({ tool, inputSchema }) => {
    if (isToolWrappedWithBeforeToolCallHook(tool)) {
      setBeforeToolCallDiagnosticsEnabled(tool, false);
      return { tool, inputSchema };
    }
    return {
      tool: wrapToolWithBeforeToolCallHook(tool, params.hookContext, { emitDiagnostics: false }),
      inputSchema,
    };
  });
  const toolMap = new Map(availableTools.map(({ tool }) => [tool.name, tool]));
  const registeredTools = registeredProjection.tools.map(({ tool }) => tool);
  const registeredToolNames = new Set(registeredTools.map((tool) => tool.name));
  const quarantinedTools = dedupeQuarantinedDynamicTools([
    ...availableProjection.quarantinedTools,
    ...registeredProjection.quarantinedTools,
  ]);
  warnQuarantinedDynamicTools(quarantinedTools);
  emitQuarantinedDynamicToolDiagnostics(quarantinedTools, params.hookContext);
  const telemetry: CodexDynamicToolBridge["telemetry"] = {
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSourceReplyPayloads: [],
    toolMediaUrls: [],
    toolAudioAsVoice: false,
    quarantinedTools,
  };
  const middlewareRunner = createAgentToolResultMiddlewareRunner({
    runtime: "codex",
    ...toolResultHookContext,
  });
  const legacyExtensionRunner =
    createCodexAppServerToolResultExtensionRunner(toolResultHookContext);
  const directToolNames = new Set([
    ...ALWAYS_DIRECT_DYNAMIC_TOOL_NAMES,
    ...(params.directToolNames ?? []),
  ]);

  return {
    availableSpecs: availableTools.map(({ tool, inputSchema }) =>
      createCodexDynamicToolSpec({
        tool,
        inputSchema,
        loading: params.loading ?? "searchable",
        directToolNames,
      }),
    ),
    specs: registeredProjection.tools.map(({ tool, inputSchema }) =>
      createCodexDynamicToolSpec({
        tool,
        inputSchema,
        loading: params.loading ?? "searchable",
        directToolNames,
      }),
    ),
    telemetry,
    handleToolCall: async (call, options) => {
      const tool = toolMap.get(call.tool);
      if (!tool) {
        if (registeredToolNames.has(call.tool)) {
          return {
            contentItems: [
              {
                type: "inputText",
                text: `OpenClaw tool is not available for this turn: ${call.tool}`,
              },
            ],
            success: false,
          };
        }
        return {
          contentItems: [{ type: "inputText", text: `Unknown OpenClaw tool: ${call.tool}` }],
          success: false,
        };
      }
      const args = jsonObjectToRecord(call.arguments);
      const startedAt = Date.now();
      const signal = composeAbortSignals(params.signal, options?.signal);
      let didStartExecution = false;
      try {
        const preparedArgs = tool.prepareArguments ? tool.prepareArguments(args) : args;
        didStartExecution = true;
        const rawResult = await tool.execute(call.callId, preparedArgs, signal);
        const rawIsError = isToolResultError(rawResult);
        const middlewareResult = await middlewareRunner.applyToolResultMiddleware({
          threadId: call.threadId,
          turnId: call.turnId,
          toolCallId: call.callId,
          toolName: tool.name,
          args,
          isError: rawIsError,
          result: rawResult,
        });
        const result = await legacyExtensionRunner.applyToolResultExtensions({
          threadId: call.threadId,
          turnId: call.turnId,
          toolCallId: call.callId,
          toolName: tool.name,
          args,
          result: middlewareResult,
        });
        const resultIsError = rawIsError || isToolResultError(result);
        collectToolTelemetry({
          toolName: tool.name,
          args,
          result,
          mediaTrustResult: rawResult,
          telemetry,
          isError: resultIsError,
        });
        void runAgentHarnessAfterToolCallHook({
          toolName: tool.name,
          toolCallId: call.callId,
          runId: toolResultHookContext.runId,
          agentId: toolResultHookContext.agentId,
          sessionId: toolResultHookContext.sessionId,
          sessionKey: toolResultHookContext.sessionKey,
          channelId: toolResultHookContext.channelId,
          startArgs: args,
          result,
          startedAt,
        });
        const terminalType = inferToolResultDiagnosticTerminalType(result, resultIsError);
        const response = withDiagnosticTerminalType(
          {
            contentItems: convertToolContents(result.content, toolResultMaxChars),
            success: !resultIsError,
          },
          terminalType,
        );
        withDynamicToolTermination(
          response,
          rawResult.terminate === true ||
            result.terminate === true ||
            isToolResultYield(rawResult) ||
            isToolResultYield(result),
        );
        withDynamicToolAsyncStarted(
          response,
          isAsyncStartedToolResult(rawResult) || isAsyncStartedToolResult(result),
        );
        return withSideEffectEvidence(response, terminalType !== "blocked");
      } catch (error) {
        collectToolTelemetry({
          toolName: tool.name,
          args,
          result: undefined,
          telemetry,
          isError: true,
        });
        void runAgentHarnessAfterToolCallHook({
          toolName: tool.name,
          toolCallId: call.callId,
          runId: toolResultHookContext.runId,
          agentId: toolResultHookContext.agentId,
          sessionId: toolResultHookContext.sessionId,
          sessionKey: toolResultHookContext.sessionKey,
          channelId: toolResultHookContext.channelId,
          startArgs: args,
          error: error instanceof Error ? error.message : String(error),
          startedAt,
        });
        return withSideEffectEvidence(
          withDiagnosticTerminalType(
            {
              contentItems: [
                {
                  type: "inputText",
                  text: error instanceof Error ? error.message : String(error),
                },
              ],
              success: false,
            },
            "error",
          ),
          didStartExecution,
        );
      }
    },
  };
}

function createCodexDynamicToolSpec(params: {
  tool: AnyAgentTool;
  inputSchema: JsonValue;
  loading: CodexDynamicToolsLoading;
  directToolNames: ReadonlySet<string>;
}): CodexDynamicToolSpec {
  const base = {
    name: params.tool.name,
    description: params.tool.description,
    inputSchema: params.inputSchema,
  };
  if (params.loading === "direct" || params.directToolNames.has(params.tool.name)) {
    return base;
  }
  return {
    ...base,
    namespace: CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE,
    deferLoading: true,
  };
}

function projectCodexDynamicTools(tools: readonly AnyAgentTool[]): {
  tools: ProjectedCodexDynamicTool[];
  quarantinedTools: CodexDynamicToolSchemaQuarantine[];
} {
  const projectedTools: ProjectedCodexDynamicTool[] = [];
  const quarantinedTools: CodexDynamicToolSchemaQuarantine[] = [];
  for (const tool of tools) {
    const projection = projectRuntimeToolInputSchema(tool.parameters, `${tool.name}.inputSchema`);
    if (projection.violations.length > 0) {
      quarantinedTools.push({ tool: tool.name, violations: projection.violations });
      continue;
    }
    projectedTools.push({ tool, inputSchema: projection.schema as JsonValue });
  }
  return { tools: projectedTools, quarantinedTools };
}

function warnQuarantinedDynamicTools(tools: readonly CodexDynamicToolSchemaQuarantine[]): void {
  if (tools.length === 0) {
    return;
  }
  const unique = new Map<string, readonly string[]>();
  for (const tool of tools) {
    unique.set(tool.tool, tool.violations);
  }
  embeddedAgentLog.warn(
    `codex app-server quarantined ${unique.size} dynamic ${unique.size === 1 ? "tool" : "tools"} with unsupported input schemas: ${[...unique.keys()].join(", ")}`,
    {
      tools: [...unique.entries()].map(([tool, violations]) => ({ tool, violations })),
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

function resolveCodexDynamicToolResultMaxChars(
  ctx: CodexDynamicToolHookContext | undefined,
): number {
  const configured = resolveAgentContextLimitValue({
    config: ctx?.config,
    agentId: ctx?.agentId,
    key: "toolResultMaxChars",
  });
  return configured ?? DEFAULT_CODEX_DYNAMIC_TOOL_RESULT_MAX_CHARS;
}

function resolveAgentContextLimitValue(params: {
  config: EmbeddedRunAttemptParams["config"] | undefined;
  agentId?: string;
  key: string;
}): number | undefined {
  const agents = readRecord(params.config?.agents);
  const defaults = readRecord(readRecord(agents?.defaults)?.contextLimits);
  const defaultValue = readPositiveInteger(defaults?.[params.key]);
  if (!params.agentId) {
    return defaultValue;
  }
  const list = agents?.list;
  if (!Array.isArray(list)) {
    return defaultValue;
  }
  const normalizedAgentId = normalizeAgentId(params.agentId);
  const agent = list.find((entry) => {
    const entryId = readRecord(entry)?.id;
    return typeof entryId === "string" && normalizeAgentId(entryId) === normalizedAgentId;
  });
  const agentValue = readPositiveInteger(
    readRecord(readRecord(agent)?.contextLimits)?.[params.key],
  );
  return agentValue ?? defaultValue;
}

function composeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length === 0) {
    return new AbortController().signal;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  return AbortSignal.any(activeSignals);
}

function collectToolTelemetry(params: {
  toolName: string;
  args: Record<string, unknown>;
  result: AgentToolResult<unknown> | undefined;
  mediaTrustResult?: AgentToolResult<unknown>;
  telemetry: CodexDynamicToolBridge["telemetry"];
  isError: boolean;
}): void {
  if (params.isError) {
    return;
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
  if (
    !isMessagingTool(params.toolName) ||
    !isMessagingToolSendAction(params.toolName, params.args)
  ) {
    return;
  }
  params.telemetry.didSendViaMessagingTool = true;
  const sourceReplyPayload = extractInternalSourceReplyPayload(params.result?.details);
  if (sourceReplyPayload) {
    params.telemetry.messagingToolSourceReplyPayloads.push(sourceReplyPayload);
    return;
  }
  const text = readFirstString(params.args, ["text", "message", "body", "content"]);
  if (text) {
    params.telemetry.messagingToolSentTexts.push(text);
  }
  const mediaUrls = collectMediaUrls(params.args);
  params.telemetry.messagingToolSentMediaUrls.push(...mediaUrls);
  params.telemetry.messagingToolSentTargets.push({
    tool: params.toolName,
    provider: readFirstString(params.args, ["provider", "channel"]) ?? params.toolName,
    accountId: readFirstString(params.args, ["accountId", "account_id"]),
    to: readFirstString(params.args, ["to", "target", "recipient"]),
    threadId: readFirstString(params.args, ["threadId", "thread_id", "messageThreadId"]),
    ...(text ? { text } : {}),
    ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
  });
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

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function isToolResultError(result: AgentToolResult<unknown>): boolean {
  const details = result.details;
  if (!isRecord(details)) {
    return false;
  }
  if (details.timedOut === true) {
    return true;
  }
  if (typeof details.exitCode === "number" && details.exitCode !== 0) {
    return true;
  }
  if (typeof details.status !== "string") {
    return false;
  }
  const status = details.status.trim().toLowerCase();
  return (
    status !== "" &&
    status !== "0" &&
    status !== "ok" &&
    status !== "success" &&
    status !== "completed" &&
    status !== "recorded" &&
    status !== "pending" &&
    status !== "started" &&
    status !== "running" &&
    status !== "yielded"
  );
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

function inferToolResultDiagnosticTerminalType(
  result: AgentToolResult<unknown>,
  isError: boolean,
): CodexDynamicToolDiagnosticTerminalType {
  const details = result.details;
  if (isRecord(details) && typeof details.status === "string") {
    const status = details.status.trim().toLowerCase();
    if (status === "blocked") {
      return "blocked";
    }
  }
  return isError ? "error" : "completed";
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

function withSideEffectEvidence<T extends CodexDynamicToolCallResponse>(
  response: T,
  sideEffectEvidence: boolean,
): T {
  if (!sideEffectEvidence) {
    return response;
  }
  Object.defineProperty(response, "sideEffectEvidence", {
    configurable: true,
    enumerable: false,
    value: true,
  });
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
    : DEFAULT_CODEX_DYNAMIC_TOOL_RESULT_MAX_CHARS;
}

function convertToolContents(
  content: Array<TextContent | ImageContent>,
  toolResultMaxChars = DEFAULT_CODEX_DYNAMIC_TOOL_RESULT_MAX_CHARS,
): CodexDynamicToolCallOutputContentItem[] {
  const maxChars = normalizeToolResultMaxChars(toolResultMaxChars);
  const totalTextChars = content.reduce(
    (total, item) => total + (item.type === "text" ? item.text.length : 0),
    0,
  );
  if (totalTextChars <= maxChars) {
    return content.flatMap(convertToolContent);
  }

  const noticeText = `...(OpenClaw truncated dynamic tool result: original ${totalTextChars} chars, showing ${maxChars}; rerun with narrower args.)`;
  const notice = `\n${noticeText}`;
  const textBudget = Math.max(0, maxChars - notice.length);
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
    if (notice.length >= maxChars) {
      output.push({ type: "inputText", text: noticeText.slice(0, maxChars) });
      appendedNotice = true;
      continue;
    }
    const sliceLength = Math.min(item.text.length, remainingTextBudget);
    remainingTextBudget -= sliceLength;
    const shouldAppendNotice = remainingTextBudget <= 0;
    const text = item.text.slice(0, sliceLength);
    if (shouldAppendNotice) {
      output.push({ type: "inputText", text: `${text.trimEnd()}${notice}`.slice(0, maxChars) });
      appendedNotice = true;
    } else if (text.length > 0) {
      output.push({ type: "inputText", text });
    }
  }

  if (!appendedNotice) {
    output.push({ type: "inputText", text: noticeText.slice(0, maxChars) });
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

function jsonObjectToRecord(value: JsonValue | undefined): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
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
