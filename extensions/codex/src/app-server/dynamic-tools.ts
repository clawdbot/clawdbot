import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  createAgentToolResultMiddlewareRunner,
  createCodexAppServerToolResultExtensionRunner,
  extractToolResultMediaArtifact,
  filterToolResultMediaUrls,
  HEARTBEAT_RESPONSE_TOOL_NAME,
  type EmbeddedRunAttemptParams,
  isToolWrappedWithBeforeToolCallHook,
  isMessagingTool,
  isMessagingToolSendAction,
  normalizeHeartbeatToolResponse,
  runAgentHarnessAfterToolCallHook,
  type AnyAgentTool,
  type HeartbeatToolResponse,
  type MessagingToolSend,
  wrapToolWithBeforeToolCallHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexDynamicToolsLoading } from "./config.js";
import {
  type CodexDynamicToolCallOutputContentItem,
  type CodexDynamicToolCallParams,
  type CodexDynamicToolCallResponse,
  type CodexDynamicToolSpec,
  type JsonValue,
} from "./protocol.js";

type CodexDynamicToolHookContext = {
  agentId?: string;
  config?: EmbeddedRunAttemptParams["config"];
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
};

type CodexToolResultHookContext = Omit<CodexDynamicToolHookContext, "config">;

export type CodexDynamicToolBridge = {
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
    heartbeatToolResponse?: HeartbeatToolResponse;
    toolMediaUrls: string[];
    toolAudioAsVoice: boolean;
    successfulCronAdds?: number;
  };
};

export const CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE = "openclaw";

const ALWAYS_DIRECT_DYNAMIC_TOOL_NAMES = new Set(["sessions_yield"]);

export function createCodexDynamicToolBridge(params: {
  tools: AnyAgentTool[];
  signal: AbortSignal;
  hookContext?: CodexDynamicToolHookContext;
  loading?: CodexDynamicToolsLoading;
  directToolNames?: Iterable<string>;
}): CodexDynamicToolBridge {
  const toolResultHookContext = toToolResultHookContext(params.hookContext);
  const tools = params.tools.map((tool) =>
    isToolWrappedWithBeforeToolCallHook(tool)
      ? tool
      : wrapToolWithBeforeToolCallHook(tool, params.hookContext),
  );
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const telemetry: CodexDynamicToolBridge["telemetry"] = {
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    toolMediaUrls: [],
    toolAudioAsVoice: false,
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
    specs: tools.map((tool) =>
      createCodexDynamicToolSpec({
        tool,
        loading: params.loading ?? "searchable",
        directToolNames,
      }),
    ),
    telemetry,
    handleToolCall: async (call, options) => {
      const tool = toolMap.get(call.tool);
      if (!tool) {
        return {
          contentItems: [{ type: "inputText", text: `Unknown OpenClaw tool: ${call.tool}` }],
          success: false,
        };
      }
      const args = jsonObjectToRecord(call.arguments);
      const startedAt = Date.now();
      const signal = composeAbortSignals(params.signal, options?.signal);
      try {
        const preparedArgs = tool.prepareArguments ? tool.prepareArguments(args) : args;
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
          startArgs: args,
          result,
          startedAt,
        });
        return {
          contentItems: result.content.flatMap(convertToolContent),
          success: !resultIsError,
        };
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
          startArgs: args,
          error: error instanceof Error ? error.message : String(error),
          startedAt,
        });
        return {
          contentItems: [
            {
              type: "inputText",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          success: false,
        };
      }
    },
  };
}

function createCodexDynamicToolSpec(params: {
  tool: AnyAgentTool;
  loading: CodexDynamicToolsLoading;
  directToolNames: ReadonlySet<string>;
}): CodexDynamicToolSpec {
  const base = {
    name: params.tool.name,
    description: params.tool.description,
    inputSchema: toJsonValue(params.tool.parameters),
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

function toToolResultHookContext(
  ctx: CodexDynamicToolHookContext | undefined,
): CodexToolResultHookContext {
  const { agentId, sessionId, sessionKey, runId } = ctx ?? {};
  return {
    ...(agentId && { agentId }),
    ...(sessionId && { sessionId }),
    ...(sessionKey && { sessionKey }),
    ...(runId && { runId }),
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    status !== "running"
  );
}

function convertToolContent(
  content: TextContent | ImageContent,
): CodexDynamicToolCallOutputContentItem[] {
  if (content.type === "text") {
    return [{ type: "inputText", text: content.text }];
  }
  return [
    {
      type: "inputImage",
      imageUrl: `data:${content.mimeType};base64,${content.data}`,
    },
  ];
}

function toJsonValue(value: unknown): JsonValue {
  try {
    const text = JSON.stringify(value);
    if (!text) {
      return {};
    }
    return JSON.parse(text) as JsonValue;
  } catch {
    return {};
  }
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
  for (const key of ["mediaUrl", "media_url", "imageUrl", "image_url"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      urls.push(value.trim());
    }
  }
  for (const key of ["mediaUrls", "media_urls", "imageUrls", "image_urls"]) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim()) {
        urls.push(entry.trim());
      }
    }
  }
  return urls;
}

function isCronAddAction(args: Record<string, unknown>): boolean {
  const action = args.action;
  return typeof action === "string" && action.trim().toLowerCase() === "add";
}
