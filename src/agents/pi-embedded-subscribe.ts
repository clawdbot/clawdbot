import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

import { formatToolAggregate } from "../auto-reply/tool-meta.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging.js";
import { splitMediaFromOutput } from "../media/parse.js";
import type { BlockReplyChunking } from "./pi-embedded-block-chunker.js";
import { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";
import {
  extractAssistantText,
  inferToolMetaFromArgs,
} from "./pi-embedded-utils.js";

const THINKING_TAG_RE = /<\s*\/?\s*think(?:ing)?\s*>/gi;
const THINKING_OPEN_RE = /<\s*think(?:ing)?\s*>/i;
const THINKING_CLOSE_RE = /<\s*\/\s*think(?:ing)?\s*>/i;
const TOOL_RESULT_MAX_CHARS = 8000;
const log = createSubsystemLogger("agent/embedded");

export type { BlockReplyChunking } from "./pi-embedded-block-chunker.js";

function truncateToolText(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n…(truncated)…`;
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

export function subscribeEmbeddedPiSession(params: {
  session: AgentSession;
  runId: string;
  verboseLevel?: "off" | "on";
  shouldEmitToolResult?: () => boolean;
  onToolResult?: (payload: {
    text?: string;
    mediaUrls?: string[];
  }) => void | Promise<void>;
  onBlockReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
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
  let deltaBuffer = "";
  let blockBuffer = "";
  let lastStreamedAssistant: string | undefined;
  let lastBlockReplyText: string | undefined;
  let assistantTextBaseline = 0;
  let compactionInFlight = false;
  let pendingCompactionRetry = 0;
  let compactionRetryResolve: (() => void) | undefined;
  let compactionRetryPromise: Promise<void> | null = null;

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
    const { text: cleanedText, mediaUrls } = splitMediaFromOutput(agg);
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

  const emitBlockChunk = (text: string) => {
    // Strip any <thinking> tags that may have leaked into the output (e.g., from Gemini mimicking history)
    const strippedText = stripThinkingSegments(stripUnpairedThinkingTags(text));
    const chunk = strippedText.trimEnd();
    if (!chunk) return;
    if (chunk === lastBlockReplyText) return;
    lastBlockReplyText = chunk;
    assistantTexts.push(chunk);
    if (!params.onBlockReply) return;
    const { text: cleanedText, mediaUrls } = splitMediaFromOutput(chunk);
    if (!cleanedText && (!mediaUrls || mediaUrls.length === 0)) return;
    void params.onBlockReply({
      text: cleanedText,
      mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
    });
  };

  const resetForCompactionRetry = () => {
    assistantTexts.length = 0;
    toolMetas.length = 0;
    toolMetaById.clear();
    toolSummaryById.clear();
    deltaBuffer = "";
    blockBuffer = "";
    blockChunker?.reset();
    lastStreamedAssistant = undefined;
    lastBlockReplyText = undefined;
    assistantTextBaseline = 0;
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
          deltaBuffer = "";
          blockBuffer = "";
          blockChunker?.reset();
          lastStreamedAssistant = undefined;
          lastBlockReplyText = undefined;
          assistantTextBaseline = assistantTexts.length;
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
        const meta = inferToolMetaFromArgs(toolName, args);
        toolMetaById.set(toolCallId, meta);
        log.debug(
          `embedded run tool start: runId=${params.runId} tool=${toolName} toolCallId=${toolCallId}`,
        );

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
          shouldEmitToolResult() &&
          !toolSummaryById.has(toolCallId)
        ) {
          toolSummaryById.add(toolCallId);
          emitToolSummary(toolName, meta);
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
        const sanitizedResult = sanitizeToolResult(result);
        const meta = toolMetaById.get(toolCallId);
        toolMetas.push({ toolName, meta });
        toolMetaById.delete(toolCallId);
        toolSummaryById.delete(toolCallId);

        emitAgentEvent({
          runId: params.runId,
          stream: "tool",
          data: {
            phase: "result",
            name: toolName,
            toolCallId,
            meta,
            isError,
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
            isError,
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

            const cleaned = params.enforceFinalTag
              ? stripThinkingSegments(stripUnpairedThinkingTags(deltaBuffer))
              : stripThinkingSegments(deltaBuffer);
            const next = params.enforceFinalTag
              ? (extractFinalText(cleaned)?.trim() ?? cleaned.trim())
              : cleaned.trim();
            if (next && next !== lastStreamedAssistant) {
              lastStreamedAssistant = next;
              const { text: cleanedText, mediaUrls } =
                splitMediaFromOutput(next);
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
              if (params.onPartialReply) {
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
          const cleaned = params.enforceFinalTag
            ? stripThinkingSegments(
                stripUnpairedThinkingTags(
                  extractAssistantText(msg as AssistantMessage),
                ),
              )
            : stripThinkingSegments(
                extractAssistantText(msg as AssistantMessage),
              );
          const text =
            params.enforceFinalTag && cleaned
              ? (extractFinalText(cleaned)?.trim() ?? cleaned)
              : cleaned;

          const addedDuringMessage =
            assistantTexts.length > assistantTextBaseline;
          const chunkingEnabled = Boolean(blockChunking);
          if (!chunkingEnabled && !addedDuringMessage && text) {
            const last = assistantTexts.at(-1);
            if (!last || last !== text) assistantTexts.push(text);
          }
          assistantTextBaseline = assistantTexts.length;

          if (
            (blockReplyBreak === "message_end" ||
              (blockChunker
                ? blockChunker.hasBuffered()
                : blockBuffer.length > 0)) &&
            text &&
            params.onBlockReply
          ) {
            if (blockChunker?.hasBuffered()) {
              blockChunker.drain({ force: true, emit: emitBlockChunk });
              blockChunker.reset();
            } else if (text !== lastBlockReplyText) {
              lastBlockReplyText = text;
              const { text: cleanedText, mediaUrls } =
                splitMediaFromOutput(text);
              if (cleanedText || (mediaUrls && mediaUrls.length > 0)) {
                void params.onBlockReply({
                  text: cleanedText,
                  mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
                });
              }
            }
          }
          deltaBuffer = "";
          blockBuffer = "";
          blockChunker?.reset();
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
