import fs from "node:fs";
import path from "node:path";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import type { ReasoningLevel } from "../auto-reply/thinking.js";
import { formatToolAggregate } from "../auto-reply/tool-meta.js";
import { resolveStateDir } from "../config/paths.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging.js";
import {
  getProviderPlugin,
  normalizeProviderId,
} from "../providers/plugins/index.js";
import { truncateUtf16Safe } from "../utils.js";
import type { BlockReplyChunking } from "./pi-embedded-block-chunker.js";
import { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";
import {
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "./pi-embedded-helpers.js";
import {
  isMessagingTool,
  isMessagingToolSendAction,
  type MessagingToolSend,
  normalizeTargetForProvider,
} from "./pi-embedded-messaging.js";
import {
  extractAssistantText,
  extractAssistantThinking,
  extractThinkingFromTaggedStream,
  extractThinkingFromTaggedText,
  formatReasoningMessage,
  inferToolMetaFromArgs,
  promoteThinkingTagsToBlocks,
} from "./pi-embedded-utils.js";

const THINKING_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
const THINKING_OPEN_RE = /<\s*(?:think(?:ing)?|thought|antthinking)\s*>/i;
const THINKING_CLOSE_RE = /<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/i;
const THINKING_TAG_SCAN_RE =
  /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
const TOOL_RESULT_MAX_CHARS = 8000;
const log = createSubsystemLogger("agent/embedded");
const RAW_STREAM_ENABLED = process.env.CLAWDBOT_RAW_STREAM === "1";
const RAW_STREAM_PATH =
  process.env.CLAWDBOT_RAW_STREAM_PATH?.trim() ||
  path.join(resolveStateDir(), "logs", "raw-stream.jsonl");
let rawStreamReady = false;

const appendRawStream = (payload: Record<string, unknown>) => {
  if (!RAW_STREAM_ENABLED) return;
  if (!rawStreamReady) {
    rawStreamReady = true;
    try {
      fs.mkdirSync(path.dirname(RAW_STREAM_PATH), { recursive: true });
    } catch {
      // ignore raw stream mkdir failures
    }
  }
  try {
    void fs.promises.appendFile(
      RAW_STREAM_PATH,
      `${JSON.stringify(payload)}\n`,
    );
  } catch {
    // ignore raw stream write failures
  }
};

export type { BlockReplyChunking } from "./pi-embedded-block-chunker.js";

function truncateToolText(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  return `${truncateUtf16Safe(text, TOOL_RESULT_MAX_CHARS)}\n…(truncated)…`;
}

function sanitizeToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : null;
  if (!content) return record;
  const sanitized = content.map((item) => {
    if (!item || typeof item !== "object") return item;
    const entry = item as Record<string, unknown>;
    const type = typeof entry.type === "string" ? entry.type : undefined;
    if (type === "text" && typeof entry.text === "string") {
      return { ...entry, text: truncateToolText(entry.text) };
    }
    if (type === "image") {
      const data = typeof entry.data === "string" ? entry.data : undefined;
      const bytes = data ? data.length : undefined;
      const cleaned = { ...entry };
      delete cleaned.data;
      return { ...cleaned, bytes, omitted: true };
    }
    return entry;
  });
  return { ...record, content: sanitized };
}

function isToolResultError(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const record = result as { details?: unknown };
  const details = record.details;
  if (!details || typeof details !== "object") return false;
  const status = (details as { status?: unknown }).status;
  if (typeof status !== "string") return false;
  const normalized = status.trim().toLowerCase();
  return normalized === "error" || normalized === "timeout";
}

function stripThinkingSegments(text: string): string {
  if (!text || !THINKING_TAG_RE.test(text)) return text;
  THINKING_TAG_RE.lastIndex = 0;
  let result = "";
  let lastIndex = 0;
  let inThinking = false;
  for (const match of text.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    if (!inThinking) {
      result += text.slice(lastIndex, idx);
    }
    const tag = match[0].toLowerCase();
    inThinking = !tag.includes("/");
    lastIndex = idx + match[0].length;
  }
  if (!inThinking) {
    result += text.slice(lastIndex);
  }
  return result;
}

function stripUnpairedThinkingTags(text: string): string {
  if (!text) return text;
  const hasOpen = THINKING_OPEN_RE.test(text);
  const hasClose = THINKING_CLOSE_RE.test(text);
  if (hasOpen && hasClose) return text;
  if (!hasOpen) return text.replace(THINKING_CLOSE_RE, "");
  if (!hasClose) return text.replace(THINKING_OPEN_RE, "");
  return text;
}

function extractMessagingToolSend(
  toolName: string,
  args: Record<string, unknown>,
): MessagingToolSend | undefined {
  // Provider docking: new provider tools must implement plugin.actions.extractToolSend.
  const action = typeof args.action === "string" ? args.action.trim() : "";
  const accountIdRaw =
    typeof args.accountId === "string" ? args.accountId.trim() : undefined;
  const accountId = accountIdRaw ? accountIdRaw : undefined;
  if (toolName === "message") {
    if (action !== "send" && action !== "thread-reply") return undefined;
    const toRaw = typeof args.to === "string" ? args.to : undefined;
    if (!toRaw) return undefined;
    const providerRaw =
      typeof args.provider === "string" ? args.provider.trim() : "";
    const providerId = providerRaw ? normalizeProviderId(providerRaw) : null;
    const provider =
      providerId ?? (providerRaw ? providerRaw.toLowerCase() : "message");
    const to = normalizeTargetForProvider(provider, toRaw);
    return to ? { tool: toolName, provider, accountId, to } : undefined;
  }
  const providerId = normalizeProviderId(toolName);
  if (!providerId) return undefined;
  const plugin = getProviderPlugin(providerId);
  const extracted = plugin?.actions?.extractToolSend?.({ args });
  if (!extracted?.to) return undefined;
  const to = normalizeTargetForProvider(providerId, extracted.to);
  return to
    ? {
        tool: toolName,
        provider: providerId,
        accountId: extracted.accountId ?? accountId,
        to,
      }
    : undefined;
}

export function subscribeEmbeddedPiSession(params: {
  session: AgentSession;
  runId: string;
  verboseLevel?: "off" | "on";
  reasoningMode?: ReasoningLevel;
  shouldEmitToolResult?: () => boolean;
  onToolResult?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onReasoningStream?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onBlockReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
    audioAsVoice?: boolean;
  }) => void | Promise<void>;
  blockReplyBreak?: "text_end" | "message_end";
  blockReplyChunking?: BlockReplyChunking;
  onPartialReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onAgentEvent?: (evt: {
    stream: string;
    data: Record<string, unknown>;
  }) => void;
  enforceFinalTag?: boolean;
}) {
  const assistantTexts: string[] = [];
  const toolMetas: Array<{ toolName?: string; meta?: string }> = [];
  const toolMetaById = new Map<string, string | undefined>();
  const toolSummaryById = new Set<string>();
  const blockReplyBreak = params.blockReplyBreak ?? "text_end";
  const reasoningMode = params.reasoningMode ?? "off";
  const includeReasoning = reasoningMode === "on";
  const shouldEmitPartialReplies = !(includeReasoning && !params.onBlockReply);
  const streamReasoning =
    reasoningMode === "stream" &&
    typeof params.onReasoningStream === "function";
  let deltaBuffer = "";
  let blockBuffer = "";
  // Track if a streamed chunk opened a <think> block (stateful across chunks).
  let blockThinkingActive = false;
  let lastStreamedAssistant: string | undefined;
  let lastStreamedReasoning: string | undefined;
  let lastBlockReplyText: string | undefined;
  let assistantTextBaseline = 0;
  let suppressBlockChunks = false; // Avoid late chunk inserts after final text merge.
  let compactionInFlight = false;
  let pendingCompactionRetry = 0;
  let compactionRetryResolve: (() => void) | undefined;
  let compactionRetryPromise: Promise<void> | null = null;
  let lastReasoningSent: string | undefined;

  const resetAssistantMessageState = (nextAssistantTextBaseline: number) => {
    deltaBuffer = "";
    blockBuffer = "";
    blockChunker?.reset();
    blockThinkingActive = false;
    lastStreamedAssistant = undefined;
    lastBlockReplyText = undefined;
    lastStreamedReasoning = undefined;
    lastReasoningSent = undefined;
    suppressBlockChunks = false;
    assistantTextBaseline = nextAssistantTextBaseline;
  };

  const finalizeAssistantTexts = (args: {
    text: string;
    addedDuringMessage: boolean;
    chunkerHasBuffered: boolean;
  }) => {
    const { text, addedDuringMessage, chunkerHasBuffered } = args;

    // If we're not streaming block replies, ensure the final payload includes
    // the final text even when interim streaming was enabled.
    if (includeReasoning && text && !params.onBlockReply) {
      if (assistantTexts.length > assistantTextBaseline) {
        assistantTexts.splice(
          assistantTextBaseline,
          assistantTexts.length - assistantTextBaseline,
          text,
        );
      } else {
        const last = assistantTexts.at(-1);
        if (!last || last !== text) assistantTexts.push(text);
      }
      suppressBlockChunks = true;
    } else if (!addedDuringMessage && !chunkerHasBuffered && text) {
      // Non-streaming models (no text_delta): ensure assistantTexts gets the final
      // text when the chunker has nothing buffered to drain.
      const last = assistantTexts.at(-1);
      if (!last || last !== text) assistantTexts.push(text);
    }

    assistantTextBaseline = assistantTexts.length;
  };

  // ── Messaging tool duplicate detection ──────────────────────────────────────
  // Track texts sent via messaging tools to suppress duplicate block replies.
  // Only committed (successful) texts are checked - pending texts are tracked
  // to support commit logic but not used for suppression (avoiding lost messages on tool failure).
  // These tools can send messages via sendMessage/threadReply actions (or sessions_send with message).
  const MAX_MESSAGING_SENT_TEXTS = 200;
  const MAX_MESSAGING_SENT_TARGETS = 200;
  const messagingToolSentTexts: string[] = [];
  const messagingToolSentTextsNormalized: string[] = [];
  const messagingToolSentTargets: MessagingToolSend[] = [];
  const pendingMessagingTexts = new Map<string, string>();
  const pendingMessagingTargets = new Map<string, MessagingToolSend>();
  const trimMessagingToolSent = () => {
    if (messagingToolSentTexts.length > MAX_MESSAGING_SENT_TEXTS) {
      const overflow = messagingToolSentTexts.length - MAX_MESSAGING_SENT_TEXTS;
      messagingToolSentTexts.splice(0, overflow);
      messagingToolSentTextsNormalized.splice(0, overflow);
    }
    if (messagingToolSentTargets.length > MAX_MESSAGING_SENT_TARGETS) {
      const overflow =
        messagingToolSentTargets.length - MAX_MESSAGING_SENT_TARGETS;
      messagingToolSentTargets.splice(0, overflow);
    }
  };

  const ensureCompactionPromise = () => {
    if (!compactionRetryPromise) {
      compactionRetryPromise = new Promise((resolve) => {
        compactionRetryResolve = resolve;
      });
    }
  };

  const noteCompactionRetry = () => {
    pendingCompactionRetry += 1;
    ensureCompactionPromise();
  };

  const resolveCompactionRetry = () => {
    if (pendingCompactionRetry <= 0) return;
    pendingCompactionRetry -= 1;
    if (pendingCompactionRetry === 0 && !compactionInFlight) {
      compactionRetryResolve?.();
      compactionRetryResolve = undefined;
      compactionRetryPromise = null;
    }
  };

  const maybeResolveCompactionWait = () => {
    if (pendingCompactionRetry === 0 && !compactionInFlight) {
      compactionRetryResolve?.();
      compactionRetryResolve = undefined;
      compactionRetryPromise = null;
    }
  };
  const FINAL_START_RE = /<\s*final\s*>/i;
  const FINAL_END_RE = /<\s*\/\s*final\s*>/i;
  // Local providers sometimes emit malformed tags; normalize before filtering.
  const sanitizeFinalText = (text: string): string => {
    if (!text) return text;
    const hasStart = FINAL_START_RE.test(text);
    const hasEnd = FINAL_END_RE.test(text);
    if (hasStart && !hasEnd) return text.replace(FINAL_START_RE, "");
    if (!hasStart && hasEnd) return text.replace(FINAL_END_RE, "");
    return text;
  };
  const extractFinalText = (text: string): string | undefined => {
    const cleaned = sanitizeFinalText(text);
    const startMatch = FINAL_START_RE.exec(cleaned);
    if (!startMatch) return undefined;
    const startIndex = startMatch.index + startMatch[0].length;
    const afterStart = cleaned.slice(startIndex);
    const endMatch = FINAL_END_RE.exec(afterStart);
    const endIndex = endMatch ? endMatch.index : afterStart.length;
    return afterStart.slice(0, endIndex);
  };

  const blockChunking = params.blockReplyChunking;
  const blockChunker = blockChunking
    ? new EmbeddedBlockChunker(blockChunking)
    : null;
  // KNOWN: Provider streams are not strictly once-only or perfectly ordered.
  // `text_end` can repeat full content; late `text_end` can arrive after `message_end`.
  // Tests: `src/agents/pi-embedded-subscribe.test.ts` (e.g. late text_end cases).
  const shouldEmitToolResult = () =>
    typeof params.shouldEmitToolResult === "function"
      ? params.shouldEmitToolResult()
      : params.verboseLevel === "on";
  const emitToolSummary = (toolName?: string, meta?: string) => {
    if (!params.onToolResult) return;
    const agg = formatToolAggregate(toolName, meta ? [meta] : undefined);
    const { text: cleanedText, mediaUrls } = parseReplyDirectives(agg);
    if (!cleanedText && (!mediaUrls || mediaUrls.length === 0)) return;
    try {
      void params.onToolResult({
        text: cleanedText,
        mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
      });
    } catch {
      // ignore tool result delivery failures
    }
  };

  const stripBlockThinkingSegments = (text: string): string => {
    if (!text) return text;
    if (!blockThinkingActive && !THINKING_TAG_SCAN_RE.test(text)) return text;
    THINKING_TAG_SCAN_RE.lastIndex = 0;
    let result = "";
    let lastIndex = 0;
    let inThinking = blockThinkingActive;
    for (const match of text.matchAll(THINKING_TAG_SCAN_RE)) {
      const idx = match.index ?? 0;
      if (!inThinking) {
        result += text.slice(lastIndex, idx);
      }
      const isClose = match[1] === "/";
      inThinking = !isClose;
      lastIndex = idx + match[0].length;
    }
    if (!inThinking) {
      result += text.slice(lastIndex);
    }
    blockThinkingActive = inThinking;
    return result;
  };

  const emitBlockChunk = (text: string) => {
    if (suppressBlockChunks) return;
    // Strip <think> blocks across chunk boundaries to avoid leaking reasoning.
    const strippedText = stripBlockThinkingSegments(text);
    const chunk = strippedText.trimEnd();
    if (!chunk) return;
    if (chunk === lastBlockReplyText) return;

    // Only check committed (successful) messaging tool texts - checking pending texts
    // is risky because if the tool fails after suppression, the user gets no response
    const normalizedChunk = normalizeTextForComparison(chunk);
    if (
      isMessagingToolDuplicateNormalized(
        normalizedChunk,
        messagingToolSentTextsNormalized,
      )
    ) {
      log.debug(
        `Skipping block reply - already sent via messaging tool: ${chunk.slice(0, 50)}...`,
      );
      return;
    }

    lastBlockReplyText = chunk;
    assistantTexts.push(chunk);
    if (!params.onBlockReply) return;
    const splitResult = parseReplyDirectives(chunk);
    const { text: cleanedText, mediaUrls, audioAsVoice } = splitResult;
    // Skip empty payloads, but always emit if audioAsVoice is set (to propagate the flag)
    if (!cleanedText && (!mediaUrls || mediaUrls.length === 0) && !audioAsVoice)
      return;
    void params.onBlockReply({
      text: cleanedText,
      mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
      audioAsVoice,
    });
  };

  const emitReasoningStream = (text: string) => {
    if (!streamReasoning || !params.onReasoningStream) return;
    const formatted = formatReasoningMessage(text);
    if (!formatted) return;
    if (formatted === lastStreamedReasoning) return;
    lastStreamedReasoning = formatted;
    void params.onReasoningStream({
      text: formatted,
    });
  };

  const resetForCompactionRetry = () => {
    assistantTexts.length = 0;
    toolMetas.length = 0;
    toolMetaById.clear();
    toolSummaryById.clear();
    messagingToolSentTexts.length = 0;
    messagingToolSentTextsNormalized.length = 0;
    messagingToolSentTargets.length = 0;
    pendingMessagingTexts.clear();
    pendingMessagingTargets.clear();
    resetAssistantMessageState(0);
  };

  const unsubscribe = params.session.subscribe(
    (evt: AgentEvent | { type: string; [k: string]: unknown }) => {
      if (evt.type === "message_start") {
        const msg = (evt as AgentEvent & { message: AgentMessage }).message;
        if (msg?.role === "assistant") {
          // KNOWN: Resetting at `text_end` is unsafe (late/duplicate end events).
          // ASSUME: `message_start` is the only reliable boundary for “new assistant message begins”.
          // Start-of-message is a safer reset point than message_end: some providers
          // may deliver late text_end updates after message_end, which would
          // otherwise re-trigger block replies.
          resetAssistantMessageState(assistantTexts.length);
        }
      }

      if (evt.type === "tool_execution_start") {
        const toolName = String(
          (evt as AgentEvent & { toolName: string }).toolName,
        );
        const toolCallId = String(
          (evt as AgentEvent & { toolCallId: string }).toolCallId,
        );
        const args = (evt as AgentEvent & { args: unknown }).args;
        if (toolName === "read") {
          const record =
            args && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {};
          const filePath =
            typeof record.path === "string" ? record.path.trim() : "";
          if (!filePath) {
            const argsPreview =
              typeof args === "string" ? args.slice(0, 200) : undefined;
            log.warn(
              `read tool called without path: toolCallId=${toolCallId} argsType=${typeof args}${argsPreview ? ` argsPreview=${argsPreview}` : ""}`,
            );
          }
        }
        const meta = inferToolMetaFromArgs(toolName, args);
        toolMetaById.set(toolCallId, meta);
        log.debug(
          `embedded run tool start: runId=${params.runId} tool=${toolName} toolCallId=${toolCallId}`,
        );

        const shouldEmitToolEvents = shouldEmitToolResult();
        emitAgentEvent({
          runId: params.runId,
          stream: "tool",
          data: {
            phase: "start",
            name: toolName,
            toolCallId,
            args: args as Record<string, unknown>,
          },
        });
        params.onAgentEvent?.({
          stream: "tool",
          data: { phase: "start", name: toolName, toolCallId },
        });

        if (
          params.onToolResult &&
          shouldEmitToolEvents &&
          !toolSummaryById.has(toolCallId)
        ) {
          toolSummaryById.add(toolCallId);
          emitToolSummary(toolName, meta);
        }

        // Track messaging tool sends (pending until confirmed in tool_execution_end)
        if (isMessagingTool(toolName)) {
          const argsRecord =
            args && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {};
          const action =
            typeof argsRecord.action === "string"
              ? argsRecord.action.trim()
              : "";
          const isMessagingSend = isMessagingToolSendAction(
            toolName,
            argsRecord,
          );
          if (isMessagingSend) {
            const sendTarget = extractMessagingToolSend(toolName, argsRecord);
            if (sendTarget) {
              pendingMessagingTargets.set(toolCallId, sendTarget);
            }
            // Field names vary by tool: Discord/Slack use "content", sessions_send uses "message"
            const text =
              (argsRecord.content as string) ?? (argsRecord.message as string);
            if (text && typeof text === "string") {
              pendingMessagingTexts.set(toolCallId, text);
              log.debug(
                `Tracking pending messaging text: tool=${toolName} action=${action} len=${text.length}`,
              );
            }
          }
        }
      }

      if (evt.type === "tool_execution_update") {
        const toolName = String(
          (evt as AgentEvent & { toolName: string }).toolName,
        );
        const toolCallId = String(
          (evt as AgentEvent & { toolCallId: string }).toolCallId,
        );
        const partial = (evt as AgentEvent & { partialResult?: unknown })
          .partialResult;
        const sanitized = sanitizeToolResult(partial);
        emitAgentEvent({
          runId: params.runId,
          stream: "tool",
          data: {
            phase: "update",
            name: toolName,
            toolCallId,
            partialResult: sanitized,
          },
        });
        params.onAgentEvent?.({
          stream: "tool",
          data: {
            phase: "update",
            name: toolName,
            toolCallId,
          },
        });
      }

      if (evt.type === "tool_execution_end") {
        const toolName = String(
          (evt as AgentEvent & { toolName: string }).toolName,
        );
        const toolCallId = String(
          (evt as AgentEvent & { toolCallId: string }).toolCallId,
        );
        const isError = Boolean(
          (evt as AgentEvent & { isError: boolean }).isError,
        );
        const result = (evt as AgentEvent & { result?: unknown }).result;
        const isToolError = isError || isToolResultError(result);
        const sanitizedResult = sanitizeToolResult(result);
        const meta = toolMetaById.get(toolCallId);
        toolMetas.push({ toolName, meta });
        toolMetaById.delete(toolCallId);
        toolSummaryById.delete(toolCallId);

        // Commit messaging tool text on success, discard on error
        const pendingText = pendingMessagingTexts.get(toolCallId);
        const pendingTarget = pendingMessagingTargets.get(toolCallId);
        if (pendingText) {
          pendingMessagingTexts.delete(toolCallId);
          if (!isToolError) {
            messagingToolSentTexts.push(pendingText);
            messagingToolSentTextsNormalized.push(
              normalizeTextForComparison(pendingText),
            );
            log.debug(
              `Committed messaging text: tool=${toolName} len=${pendingText.length}`,
            );
            trimMessagingToolSent();
          }
        }
        if (pendingTarget) {
          pendingMessagingTargets.delete(toolCallId);
          if (!isToolError) {
            messagingToolSentTargets.push(pendingTarget);
            trimMessagingToolSent();
          }
        }

        emitAgentEvent({
          runId: params.runId,
          stream: "tool",
          data: {
            phase: "result",
            name: toolName,
            toolCallId,
            meta,
            isError: isToolError,
            result: sanitizedResult,
          },
        });
        params.onAgentEvent?.({
          stream: "tool",
          data: {
            phase: "result",
            name: toolName,
            toolCallId,
            meta,
            isError: isToolError,
          },
        });
      }

      if (evt.type === "message_update") {
        const msg = (evt as AgentEvent & { message: AgentMessage }).message;
        if (msg?.role === "assistant") {
          const assistantEvent = (
            evt as AgentEvent & { assistantMessageEvent?: unknown }
          ).assistantMessageEvent;
          const assistantRecord =
            assistantEvent && typeof assistantEvent === "object"
              ? (assistantEvent as Record<string, unknown>)
              : undefined;
          const evtType =
            typeof assistantRecord?.type === "string"
              ? assistantRecord.type
              : "";
          if (
            evtType === "text_delta" ||
            evtType === "text_start" ||
            evtType === "text_end"
          ) {
            const delta =
              typeof assistantRecord?.delta === "string"
                ? assistantRecord.delta
                : "";
            const content =
              typeof assistantRecord?.content === "string"
                ? assistantRecord.content
                : "";
            appendRawStream({
              ts: Date.now(),
              event: "assistant_text_stream",
              runId: params.runId,
              sessionId: (params.session as { id?: string }).id,
              evtType,
              delta,
              content,
            });
            let chunk = "";
            if (evtType === "text_delta") {
              chunk = delta;
            } else if (evtType === "text_start" || evtType === "text_end") {
              if (delta) {
                chunk = delta;
              } else if (content) {
                // KNOWN: Some providers resend full content on `text_end`.
                // We only append a suffix (or nothing) to keep output monotonic.
                // Providers may resend full content on text_end; append only the suffix.
                if (content.startsWith(deltaBuffer)) {
                  chunk = content.slice(deltaBuffer.length);
                } else if (deltaBuffer.startsWith(content)) {
                  chunk = "";
                } else if (!deltaBuffer.includes(content)) {
                  chunk = content;
                }
              }
            }
            if (chunk) {
              deltaBuffer += chunk;
              if (blockChunker) {
                blockChunker.append(chunk);
              } else {
                blockBuffer += chunk;
              }
            }

            if (streamReasoning) {
              // Handle partial <think> tags: stream whatever reasoning is visible so far.
              emitReasoningStream(extractThinkingFromTaggedStream(deltaBuffer));
            }

            const cleaned = params.enforceFinalTag
              ? stripThinkingSegments(stripUnpairedThinkingTags(deltaBuffer))
              : stripThinkingSegments(deltaBuffer);
            const next = params.enforceFinalTag
              ? (extractFinalText(cleaned)?.trim() ?? cleaned.trim())
              : cleaned.trim();
            if (next && next !== lastStreamedAssistant) {
              lastStreamedAssistant = next;
              const { text: cleanedText, mediaUrls } =
                parseReplyDirectives(next);
              emitAgentEvent({
                runId: params.runId,
                stream: "assistant",
                data: {
                  text: cleanedText,
                  mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
                },
              });
              params.onAgentEvent?.({
                stream: "assistant",
                data: {
                  text: cleanedText,
                  mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
                },
              });
              if (params.onPartialReply && shouldEmitPartialReplies) {
                void params.onPartialReply({
                  text: cleanedText,
                  mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
                });
              }
            }

            if (
              params.onBlockReply &&
              blockChunking &&
              blockReplyBreak === "text_end"
            ) {
              blockChunker?.drain({ force: false, emit: emitBlockChunk });
            }

            if (evtType === "text_end" && blockReplyBreak === "text_end") {
              if (blockChunker?.hasBuffered()) {
                blockChunker.drain({ force: true, emit: emitBlockChunk });
                blockChunker.reset();
              } else if (blockBuffer.length > 0) {
                emitBlockChunk(blockBuffer);
                blockBuffer = "";
              }
            }
          }
        }
      }

      if (evt.type === "message_end") {
        const msg = (evt as AgentEvent & { message: AgentMessage }).message;
        if (msg?.role === "assistant") {
          const assistantMessage = msg as AssistantMessage;
          promoteThinkingTagsToBlocks(assistantMessage);
          const rawText = extractAssistantText(assistantMessage);
          appendRawStream({
            ts: Date.now(),
            event: "assistant_message_end",
            runId: params.runId,
            sessionId: (params.session as { id?: string }).id,
            rawText,
            rawThinking: extractAssistantThinking(assistantMessage),
          });
          const cleaned = params.enforceFinalTag
            ? stripThinkingSegments(stripUnpairedThinkingTags(rawText))
            : stripThinkingSegments(rawText);
          const baseText =
            params.enforceFinalTag && cleaned
              ? (extractFinalText(cleaned)?.trim() ?? cleaned)
              : cleaned;
          const rawThinking =
            includeReasoning || streamReasoning
              ? extractAssistantThinking(assistantMessage) ||
                extractThinkingFromTaggedText(rawText)
              : "";
          const formattedReasoning = rawThinking
            ? formatReasoningMessage(rawThinking)
            : "";
          const text = baseText;

          const addedDuringMessage =
            assistantTexts.length > assistantTextBaseline;
          const chunkerHasBuffered = blockChunker?.hasBuffered() ?? false;
          finalizeAssistantTexts({
            text,
            addedDuringMessage,
            chunkerHasBuffered,
          });

          const onBlockReply = params.onBlockReply;
          const shouldEmitReasoning = Boolean(
            includeReasoning &&
              formattedReasoning &&
              onBlockReply &&
              formattedReasoning !== lastReasoningSent,
          );
          const shouldEmitReasoningBeforeAnswer =
            shouldEmitReasoning &&
            blockReplyBreak === "message_end" &&
            !addedDuringMessage;
          const maybeEmitReasoning = () => {
            if (!shouldEmitReasoning || !formattedReasoning) return;
            lastReasoningSent = formattedReasoning;
            void onBlockReply?.({ text: formattedReasoning });
          };

          if (shouldEmitReasoningBeforeAnswer) maybeEmitReasoning();

          if (
            (blockReplyBreak === "message_end" ||
              (blockChunker
                ? blockChunker.hasBuffered()
                : blockBuffer.length > 0)) &&
            text &&
            onBlockReply
          ) {
            if (blockChunker?.hasBuffered()) {
              blockChunker.drain({ force: true, emit: emitBlockChunk });
              blockChunker.reset();
            } else if (text !== lastBlockReplyText) {
              // Check for duplicates before emitting (same logic as emitBlockChunk)
              const normalizedText = normalizeTextForComparison(text);
              if (
                isMessagingToolDuplicateNormalized(
                  normalizedText,
                  messagingToolSentTextsNormalized,
                )
              ) {
                log.debug(
                  `Skipping message_end block reply - already sent via messaging tool: ${text.slice(0, 50)}...`,
                );
              } else {
                lastBlockReplyText = text;
                const {
                  text: cleanedText,
                  mediaUrls,
                  audioAsVoice,
                } = parseReplyDirectives(text);
                // Emit if there's content OR audioAsVoice flag (to propagate the flag)
                if (
                  cleanedText ||
                  (mediaUrls && mediaUrls.length > 0) ||
                  audioAsVoice
                ) {
                  void onBlockReply({
                    text: cleanedText,
                    mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
                    audioAsVoice,
                  });
                }
              }
            }
          }
          if (!shouldEmitReasoningBeforeAnswer) maybeEmitReasoning();
          if (streamReasoning && rawThinking) {
            emitReasoningStream(rawThinking);
          }
          deltaBuffer = "";
          blockBuffer = "";
          blockChunker?.reset();
          blockThinkingActive = false;
          lastStreamedAssistant = undefined;
        }
      }

      if (evt.type === "tool_execution_end") {
        const toolName = String(
          (evt as AgentEvent & { toolName: string }).toolName,
        );
        const toolCallId = String(
          (evt as AgentEvent & { toolCallId: string }).toolCallId,
        );
        log.debug(
          `embedded run tool end: runId=${params.runId} tool=${toolName} toolCallId=${toolCallId}`,
        );
      }

      if (evt.type === "agent_start") {
        log.debug(`embedded run agent start: runId=${params.runId}`);
        emitAgentEvent({
          runId: params.runId,
          stream: "lifecycle",
          data: {
            phase: "start",
            startedAt: Date.now(),
          },
        });
        params.onAgentEvent?.({
          stream: "lifecycle",
          data: { phase: "start" },
        });
      }

      if (evt.type === "auto_compaction_start") {
        compactionInFlight = true;
        ensureCompactionPromise();
        log.debug(`embedded run compaction start: runId=${params.runId}`);
        params.onAgentEvent?.({
          stream: "compaction",
          data: { phase: "start" },
        });
      }

      if (evt.type === "auto_compaction_end") {
        compactionInFlight = false;
        const willRetry = Boolean((evt as { willRetry?: unknown }).willRetry);
        if (willRetry) {
          noteCompactionRetry();
          resetForCompactionRetry();
          log.debug(`embedded run compaction retry: runId=${params.runId}`);
        } else {
          maybeResolveCompactionWait();
        }
        params.onAgentEvent?.({
          stream: "compaction",
          data: { phase: "end", willRetry },
        });
      }

      if (evt.type === "agent_end") {
        log.debug(`embedded run agent end: runId=${params.runId}`);
        emitAgentEvent({
          runId: params.runId,
          stream: "lifecycle",
          data: {
            phase: "end",
            endedAt: Date.now(),
          },
        });
        params.onAgentEvent?.({
          stream: "lifecycle",
          data: { phase: "end" },
        });
        if (params.onBlockReply) {
          if (blockChunker?.hasBuffered()) {
            blockChunker.drain({ force: true, emit: emitBlockChunk });
            blockChunker.reset();
          } else if (blockBuffer.length > 0) {
            emitBlockChunk(blockBuffer);
            blockBuffer = "";
          }
        }
        blockThinkingActive = false;
        if (pendingCompactionRetry > 0) {
          resolveCompactionRetry();
        } else {
          maybeResolveCompactionWait();
        }
      }
    },
  );

  return {
    assistantTexts,
    toolMetas,
    unsubscribe,
    isCompacting: () => compactionInFlight || pendingCompactionRetry > 0,
    getMessagingToolSentTexts: () => messagingToolSentTexts.slice(),
    getMessagingToolSentTargets: () => messagingToolSentTargets.slice(),
    // Returns true if any messaging tool successfully sent a message.
    // Used to suppress agent's confirmation text (e.g., "Respondi no Telegram!")
    // which is generated AFTER the tool sends the actual answer.
    didSendViaMessagingTool: () => messagingToolSentTexts.length > 0,
    waitForCompactionRetry: () => {
      if (compactionInFlight || pendingCompactionRetry > 0) {
        ensureCompactionPromise();
        return compactionRetryPromise ?? Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        queueMicrotask(() => {
          if (compactionInFlight || pendingCompactionRetry > 0) {
            ensureCompactionPromise();
            void (compactionRetryPromise ?? Promise.resolve()).then(resolve);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
