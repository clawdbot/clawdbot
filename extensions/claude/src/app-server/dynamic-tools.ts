/**
 * Projects OpenClaw's tool registry into the `DynamicToolSpec[]` shape the
 * codex-shaped server consumes, and dispatches `item/tool/call` requests
 * back to the underlying `AnyAgentTool` instances.
 *
 * Native hook relay + telemetry are wired through the same plugin-SDK
 * helpers codex uses:
 *   - `wrapToolWithBeforeToolCallHook` fires OpenClaw `BeforeToolCall` hooks
 *     around each tool execution so plugin observers see Claude's calls.
 *   - `runAgentHarnessAfterToolCallHook` fires the `AfterToolCall` hook with
 *     timing + result.
 *   - `extractToolResultMediaArtifact` + `filterToolResultMediaUrls` lift
 *     media URLs and audio-as-voice flags out of tool results into the
 *     telemetry channel the run-attempt copies into AttemptResult.
 *   - `isMessagingTool` + `isMessagingToolSendAction` detect when Claude
 *     called OpenClaw's `message` tool so we can populate
 *     `didSendViaMessagingTool` and the messagingToolSent* fields.
 *   - `isDeliveredMessageToolOnlySourceReplyResult` decides whether such a
 *     send actually satisfied the current source reply, so
 *     `didDeliverSourceReplyViaMessageTool` and the per-send
 *     `sourceReplyFinal` markers carry the same meaning they do on the
 *     embedded and codex paths.
 */

import {
  createAgentToolResultMiddlewareRunner,
  extractToolResultMediaArtifact,
  filterToolResultMediaUrls,
  HEARTBEAT_RESPONSE_TOOL_NAME,
  isDeliveredMessageToolOnlySourceReplyResult,
  isMessagingTool,
  isMessagingToolSendAction,
  isToolWrappedWithBeforeToolCallHook,
  normalizeHeartbeatToolResponse,
  runAgentHarnessAfterToolCallHook,
  setBeforeToolCallDiagnosticsEnabled,
  wrapToolWithBeforeToolCallHook,
  type AnyAgentTool,
  type EmbeddedRunAttemptParams,
  type HeartbeatToolResponse,
  type MessagingToolSend,
  type MessagingToolSourceReplyPayload,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type {
  DynamicToolCallOutputContentItem,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec,
  JsonValue,
} from "./types.js";

export type ClaudeDynamicToolHookContext = {
  agentId?: string;
  config?: EmbeddedRunAttemptParams["config"];
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  channelId?: string;
  sourceReplyDeliveryMode?: EmbeddedRunAttemptParams["sourceReplyDeliveryMode"];
};

export type ClaudeDynamicToolTelemetry = {
  didSendViaMessagingTool: boolean;
  /**
   * True once a messaging-tool send satisfied the run's current source
   * reply. `hasCompletedSourceReplyDeliveryEvidence` reads this (plus the
   * `sourceReplyFinal` markers below) to decide whether a
   * `message_tool_only` turn delivered anything visible; without it every
   * claude-bridge turn settles as if the agent had stayed silent.
   */
  didDeliverSourceReplyViaMessageTool: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: MessagingToolSend[];
  /**
   * Internal-UI source-reply payloads extracted from messaging-tool
   * results. Mirrors codex's `messagingToolSourceReplyPayloads`. When
   * a messaging tool returns a `details.sourceReplySink === "internal-ui"`
   * payload (the agent invoked the tool to surface a structured reply
   * to a source message rather than send a fresh message), the payload
   * lands here and `messagingToolSent*` fields are skipped for that
   * call — matches codex's source-reply attribution path so the
   * downstream reply pipeline keeps its parent-message context.
   */
  messagingToolSourceReplyPayloads: MessagingToolSourceReplyPayload[];
  heartbeatToolResponse?: HeartbeatToolResponse;
  toolMediaUrls: string[];
  toolAudioAsVoice: boolean;
};

export type ClaudeDynamicToolBridge = {
  specs: DynamicToolSpec[];
  telemetry: ClaudeDynamicToolTelemetry;
  handleToolCall: (
    params: DynamicToolCallParams,
    options?: { signal?: AbortSignal },
  ) => Promise<DynamicToolCallResponse>;
};

export type ClaudeDynamicToolsLoading = "searchable" | "direct";

/**
 * Tool namespace for searchable (deferred-loadable) dynamic tools.
 * Mirrors codex's CODEX_OPENCLAW_DYNAMIC_TOOL_NAMESPACE. The Anthropic
 * SDK doesn't yet honor namespaces or deferLoading at runtime — these
 * fields are forwarded as protocol metadata so they're correct when
 * the SDK grows support (or when the server adds a search-meta-tool
 * over MCP).
 */
export const CLAUDE_OPENCLAW_DYNAMIC_TOOL_NAMESPACE = "openclaw";

/**
 * Names that must always be registered eagerly even in "searchable"
 * mode — agents need them callable without a search-tool hop. Mirrors
 * codex's ALWAYS_DIRECT_DYNAMIC_TOOL_NAMES.
 */
const ALWAYS_DIRECT_DYNAMIC_TOOL_NAMES = new Set<string>(["sessions_yield"]);

export function createClaudeDynamicToolBridge(params: {
  tools: AnyAgentTool[];
  signal?: AbortSignal;
  excludeNames?: Iterable<string>;
  hookContext?: ClaudeDynamicToolHookContext;
  /**
   * "direct" registers every tool eagerly with the SDK (current default
   * behavior and what every existing call site does); "searchable" marks
   * non-direct tools as deferred-loadable so the SDK / MCP layer can
   * lazy-load them when it grows support. Defaults to "direct" to
   * preserve current behavior — flip to "searchable" once server-side
   * deferred-loading lands.
   */
  loading?: ClaudeDynamicToolsLoading;
  directToolNames?: Iterable<string>;
}): ClaudeDynamicToolBridge {
  const excluded = new Set([...(params.excludeNames ?? [])].map((n) => n.trim()).filter(Boolean));
  const hookContext = params.hookContext ?? {};
  const toolResultMaxChars = resolveClaudeDynamicToolResultMaxChars(hookContext);
  const middlewareRunner = createAgentToolResultMiddlewareRunner({
    runtime: "claude",
    ...(hookContext.agentId ? { agentId: hookContext.agentId } : {}),
    ...(hookContext.sessionId ? { sessionId: hookContext.sessionId } : {}),
    ...(hookContext.sessionKey ? { sessionKey: hookContext.sessionKey } : {}),
    ...(hookContext.runId ? { runId: hookContext.runId } : {}),
  });
  // Wrap each tool so OpenClaw `BeforeToolCall` hooks fire around it. The
  // runtime's existing wrapping (if any) is preserved; we only attach when
  // missing.
  const wrappedTools = params.tools
    .filter((tool) => tool?.name && !excluded.has(tool.name))
    .map((tool) => {
      if (isToolWrappedWithBeforeToolCallHook(tool)) {
        setBeforeToolCallDiagnosticsEnabled(tool, false);
        return tool;
      }
      return wrapToolWithBeforeToolCallHook(tool, hookContext, { emitDiagnostics: false });
    });
  const toolsByName = new Map(wrappedTools.map((t) => [t.name, t]));
  const loading: ClaudeDynamicToolsLoading = params.loading ?? "direct";
  const directToolNames = new Set<string>([
    ...ALWAYS_DIRECT_DYNAMIC_TOOL_NAMES,
    ...(params.directToolNames ?? []),
  ]);
  const specs: DynamicToolSpec[] = wrappedTools.map((tool) => {
    const spec: DynamicToolSpec = {
      name: tool.name,
      description: tool.description ?? "",
      // TypeBox schemas are JSON-Schema-shaped; ship verbatim.
      inputSchema: (tool.parameters ?? { type: "object", additionalProperties: true }) as JsonValue,
    };
    if (loading !== "direct" && !directToolNames.has(tool.name)) {
      spec.namespace = CLAUDE_OPENCLAW_DYNAMIC_TOOL_NAMESPACE;
      spec.deferLoading = true;
    }
    return spec;
  });
  const telemetry: ClaudeDynamicToolTelemetry = {
    didSendViaMessagingTool: false,
    didDeliverSourceReplyViaMessageTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSourceReplyPayloads: [],
    toolMediaUrls: [],
    toolAudioAsVoice: false,
  };

  async function handleToolCall(
    call: DynamicToolCallParams,
    options?: { signal?: AbortSignal },
  ): Promise<DynamicToolCallResponse> {
    const tool = toolsByName.get(call.tool);
    if (!tool) {
      return errorResponse(`Unknown openclaw tool: ${call.tool}`);
    }
    const callerSignal = options?.signal ?? params.signal;
    const args = (call.arguments ?? {}) as Record<string, unknown>;
    const startedAt = Date.now();
    try {
      const preparedArgs = tool.prepareArguments ? tool.prepareArguments(args) : args;
      const rawResult = await tool.execute(call.callId, preparedArgs, callerSignal);
      const rawIsError = isResultError(rawResult);
      const result = await middlewareRunner.applyToolResultMiddleware({
        threadId: call.threadId,
        turnId: call.turnId,
        toolCallId: call.callId,
        toolName: tool.name,
        args,
        isError: rawIsError,
        result: rawResult as Parameters<
          typeof middlewareRunner.applyToolResultMiddleware
        >[0]["result"],
      });
      const isError = rawIsError || isResultError(result);
      collectTelemetry({
        telemetry,
        toolName: tool.name,
        args,
        result,
        hookResult: rawResult,
        isError,
        sourceReplyDeliveryMode: hookContext.sourceReplyDeliveryMode,
      });
      void runAgentHarnessAfterToolCallHook({
        toolName: tool.name,
        toolCallId: call.callId,
        runId: hookContext.runId,
        agentId: hookContext.agentId,
        sessionId: hookContext.sessionId,
        sessionKey: hookContext.sessionKey,
        channelId: hookContext.channelId,
        startArgs: args,
        result,
        startedAt,
      });
      return {
        contentItems: projectContentItems(result, toolResultMaxChars),
        success: !isError,
      };
    } catch (err) {
      collectTelemetry({
        telemetry,
        toolName: tool.name,
        args,
        result: undefined,
        isError: true,
        sourceReplyDeliveryMode: hookContext.sourceReplyDeliveryMode,
      });
      const message = err instanceof Error ? err.message : String(err);
      void runAgentHarnessAfterToolCallHook({
        toolName: tool.name,
        toolCallId: call.callId,
        runId: hookContext.runId,
        agentId: hookContext.agentId,
        sessionId: hookContext.sessionId,
        sessionKey: hookContext.sessionKey,
        channelId: hookContext.channelId,
        startArgs: args,
        error: message,
        startedAt,
      });
      return errorResponse(`Tool execution failed: ${message}`);
    }
  }

  return { specs, telemetry, handleToolCall };
}

// ─── Telemetry ──────────────────────────────────────────────────────────────

function collectTelemetry(params: {
  telemetry: ClaudeDynamicToolTelemetry;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  /** Pre-middleware result; carries the same delivery envelope codex reads. */
  hookResult?: unknown;
  isError: boolean;
  sourceReplyDeliveryMode?: EmbeddedRunAttemptParams["sourceReplyDeliveryMode"];
}): void {
  if (!params.isError && params.toolName === HEARTBEAT_RESPONSE_TOOL_NAME) {
    const response = normalizeHeartbeatToolResponse(
      (params.result as { details?: unknown } | undefined)?.details,
    );
    if (response) {
      params.telemetry.heartbeatToolResponse = response;
    }
  }
  if (!params.isError && params.result) {
    const media = extractToolResultMediaArtifact(params.result);
    if (media) {
      const mediaUrls = filterToolResultMediaUrls(params.toolName, media.mediaUrls, params.result);
      const seen = new Set(params.telemetry.toolMediaUrls);
      for (const url of mediaUrls) {
        if (!seen.has(url)) {
          seen.add(url);
          params.telemetry.toolMediaUrls.push(url);
        }
      }
      if (media.audioAsVoice) {
        params.telemetry.toolAudioAsVoice = true;
      }
    }
  }
  if (!isMessagingTool(params.toolName)) {
    return;
  }
  if (!isMessagingToolSendAction(params.toolName, params.args)) {
    return;
  }
  params.telemetry.didSendViaMessagingTool = true;
  // Did this send satisfy the run's *current source* reply? Mirrors codex's
  // attribution (extensions/codex/.../dynamic-tools.ts). `allowExplicitSourceRoute`
  // is deliberately left unset so a send carrying an explicit route
  // (`to`/`channel`/`target`/...) is not credited as the source reply — the
  // bridge has no confirmed target record to route-check it against, and
  // failing closed here only costs a `mute`, while failing open would
  // suppress genuine undelivered-reply recovery.
  const deliveredSourceReply = isDeliveredMessageToolOnlySourceReplyResult({
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    toolName: params.toolName,
    args: params.args,
    result: params.result,
    hookResult: params.hookResult,
    isError: params.isError,
  });
  // `final` defaults to true: an ordinary `message(action=send)` with no
  // `final` argument terminates the source reply, matching the message tool's
  // own `resolveMessageToolSourceReplyFinal`.
  const sourceReplyFinal = deliveredSourceReply ? params.args.final !== false : undefined;
  if (deliveredSourceReply) {
    params.telemetry.didDeliverSourceReplyViaMessageTool = true;
  }
  // Source-reply path: the agent invoked a messaging tool to surface a
  // structured reply to a parent source message (not a fresh outbound
  // send). The tool result carries the rich payload under
  // `details.sourceReply` with `details.sourceReplySink === "internal-ui"`;
  // route it through the source-reply pipeline instead of the regular
  // sent-text/media tracking. Mirrors codex.
  const sourceReplyPayload = extractInternalSourceReplyPayload(
    (params.result as { details?: unknown } | undefined)?.details,
  );
  if (sourceReplyPayload) {
    params.telemetry.messagingToolSourceReplyPayloads.push({
      ...sourceReplyPayload,
      ...(sourceReplyFinal !== undefined ? { sourceReplyFinal } : {}),
    });
    return;
  }
  const text = readFirstString(params.args, ["text", "message", "body", "content"]);
  if (text) {
    params.telemetry.messagingToolSentTexts.push(text);
  }
  const mediaUrls = collectArgMediaUrls(params.args);
  params.telemetry.messagingToolSentMediaUrls.push(...mediaUrls);
  params.telemetry.messagingToolSentTargets.push({
    tool: params.toolName,
    provider: readFirstString(params.args, ["provider", "channel"]) ?? params.toolName,
    accountId: readFirstString(params.args, ["accountId", "account_id"]),
    to: readFirstString(params.args, ["to", "target", "recipient"]),
    threadId: readFirstString(params.args, ["threadId", "thread_id", "messageThreadId"]),
    ...(text ? { text } : {}),
    ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
    ...(sourceReplyFinal !== undefined ? { sourceReplyFinal } : {}),
  } as MessagingToolSend);
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
  const mediaUrls = collectArgMediaUrls(rawPayload);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ─── Result projection ──────────────────────────────────────────────────────

/**
 * Default aggregate cap for dynamic-tool inputText content sent back to the
 * SDK. Mirrors codex's DEFAULT_CODEX_DYNAMIC_TOOL_RESULT_MAX_CHARS. The
 * configured value resolved from `agents.list[].contextLimits.toolResultMaxChars`
 * (falling back to `agents.defaults.contextLimits.toolResultMaxChars`)
 * overrides this default at the call site.
 *
 * Without this cap, a tool that returns a very large payload (e.g.
 * file_fetch on a huge file, vestige_search with a wide query) silently
 * inflates the model's input window — Anthropic's API rejects payloads
 * exceeding its limits with an opaque 400 instead.
 *
 * Budgeting is aggregate across all text items in a single tool result, not
 * per-block: a multi-block result whose blocks individually fit but whose
 * sum exceeds the cap still gets truncated.
 */
export const DEFAULT_CLAUDE_DYNAMIC_TOOL_RESULT_MAX_CHARS = 16_000;

function normalizeToolResultMaxChars(maxChars: number): number {
  return typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0
    ? Math.floor(maxChars)
    : DEFAULT_CLAUDE_DYNAMIC_TOOL_RESULT_MAX_CHARS;
}

export function resolveClaudeDynamicToolResultMaxChars(
  ctx: ClaudeDynamicToolHookContext | undefined,
): number {
  const configured = resolveAgentContextLimitValue({
    config: ctx?.config,
    agentId: ctx?.agentId,
    key: "toolResultMaxChars",
  });
  return configured ?? DEFAULT_CLAUDE_DYNAMIC_TOOL_RESULT_MAX_CHARS;
}

function resolveAgentContextLimitValue(params: {
  config: EmbeddedRunAttemptParams["config"] | undefined;
  agentId?: string;
  key: string;
}): number | undefined {
  const agents = readRecord((params.config as Record<string, unknown> | undefined)?.agents);
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

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

type UntruncatedContentItem = { type: "text"; text: string } | { type: "image"; imageUrl: string };

function extractUntruncatedContentItems(result: unknown): UntruncatedContentItem[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return [{ type: "text", text: String(result) }];
  }
  const obj = result as Record<string, unknown>;
  const items: UntruncatedContentItem[] = [];
  const content = obj.content;
  if (typeof content === "string") {
    items.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        items.push({ type: "text", text: b.text });
      } else if (b.type === "image_url" && typeof b.image_url === "string") {
        items.push({ type: "image", imageUrl: b.image_url });
      } else if (b.type === "image" && typeof b.url === "string") {
        items.push({ type: "image", imageUrl: b.url });
      }
    }
  }
  if (items.length === 0) {
    if (typeof obj.text === "string") {
      items.push({ type: "text", text: obj.text });
    } else {
      items.push({ type: "text", text: stringify(obj) });
    }
  }
  return items;
}

function projectContentItems(
  result: unknown,
  toolResultMaxChars: number = DEFAULT_CLAUDE_DYNAMIC_TOOL_RESULT_MAX_CHARS,
): DynamicToolCallOutputContentItem[] {
  const maxChars = normalizeToolResultMaxChars(toolResultMaxChars);
  const items = extractUntruncatedContentItems(result);
  const totalTextChars = items.reduce(
    (sum, item) => sum + (item.type === "text" ? item.text.length : 0),
    0,
  );
  if (totalTextChars <= maxChars) {
    return items.map(toDynamicOutputItem);
  }

  const noticeText = `...(OpenClaw truncated dynamic tool result: original ${totalTextChars} chars, showing ${maxChars}; rerun with narrower args.)`;
  const notice = `\n${noticeText}`;
  const textBudget = Math.max(0, maxChars - notice.length);
  let remainingTextBudget = textBudget;
  let appendedNotice = false;
  const output: DynamicToolCallOutputContentItem[] = [];

  for (const item of items) {
    if (item.type !== "text") {
      output.push({ type: "inputImage", imageUrl: item.imageUrl });
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

function toDynamicOutputItem(item: UntruncatedContentItem): DynamicToolCallOutputContentItem {
  return item.type === "text"
    ? { type: "inputText", text: item.text }
    : { type: "inputImage", imageUrl: item.imageUrl };
}

/**
 * Per-string truncation helper retained for callers that hold a single
 * string and want a tagged elision. The dynamic-tool result path uses
 * aggregate budgeting via projectContentItems; this helper is only used
 * by tests and one-off callers.
 */
export function truncateForToolResult(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  const reserve = ` [truncated to ${maxChars} chars]`;
  const sliceLen = Math.max(0, maxChars - reserve.length);
  return `${text.slice(0, sliceLen)}${reserve}`;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isResultError(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  const obj = result as Record<string, unknown>;
  return obj.isError === true || obj.is_error === true;
}

function readFirstString(
  args: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) {
      return v;
    }
  }
  return undefined;
}

function collectArgMediaUrls(args: Record<string, unknown>): string[] {
  const urls: string[] = [];
  for (const key of ["mediaUrls", "mediaUrl", "imageUrls", "imageUrl", "url", "urls"]) {
    const v = args[key];
    if (typeof v === "string") {
      urls.push(v);
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string") {
          urls.push(item);
        }
      }
    }
  }
  return urls;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorResponse(message: string): DynamicToolCallResponse {
  return { contentItems: [{ type: "inputText", text: message }], success: false };
}
