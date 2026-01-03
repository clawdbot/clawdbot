import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

import {
  createToolDebouncer,
  formatToolAggregate,
} from "../auto-reply/tool-meta.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { defaultRuntime } from "../runtime.js";
import {
  extractAssistantText,
  inferToolMetaFromArgs,
} from "./pi-embedded-utils.js";

const THINKING_TAG_RE = /<\s*\/?\s*think(?:ing)?\s*>/gi;
const THINKING_OPEN_RE = /<\s*think(?:ing)?\s*>/i;
const THINKING_CLOSE_RE = /<\s*\/\s*think(?:ing)?\s*>/i;
const TOOL_RESULT_MAX_CHARS = 8000;

export type BlockReplyChunking = {
  minChars: number;
  maxChars: number;
  breakPreference?: "paragraph" | "newline" | "sentence";
};

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

  const toolDebouncer = createToolDebouncer((toolName, metas) => {
    if (!params.onPartialReply) return;
    const text = formatToolAggregate(toolName, metas);
    const { text: cleanedText, mediaUrls } = splitMediaFromOutput(text);
    void params.onPartialReply({
      text: cleanedText,
      mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
    });
  });

  const blockChunking = params.blockReplyChunking;

  const findSentenceBreak = (window: string, minChars: number): number => {
    if (!window) return -1;
    const matches = window.matchAll(/[.!?](?=\s|$)/g);
    let idx = -1;
    for (const match of matches) {
      const at = match.index ?? -1;
      if (at < minChars) continue;
      idx = at + 1;
    }
    return idx;
  };

  const findWhitespaceBreak = (window: string, minChars: number): number => {
    for (let i = window.length - 1; i >= minChars; i--) {
      if (/\s/.test(window[i])) return i;
    }
    return -1;
  };

  const pickBreakIndex = (buffer: string): number => {
    if (!blockChunking) return -1;
    const minChars = Math.max(1, Math.floor(blockChunking.minChars));
    const maxChars = Math.max(minChars, Math.floor(blockChunking.maxChars));
    if (buffer.length < minChars) return -1;
    const window = buffer.slice(0, Math.min(maxChars, buffer.length));

    const preference = blockChunking.breakPreference ?? "paragraph";
    const paragraphIdx = window.lastIndexOf("\n\n");
    if (preference === "paragraph" && paragraphIdx >= minChars) {
      return paragraphIdx;
    }

    const newlineIdx = window.lastIndexOf("\n");
    if (
      (preference === "paragraph" || preference === "newline") &&
      newlineIdx >= minChars
    ) {
      return newlineIdx;
    }

    if (preference !== "newline") {
      const sentenceIdx = findSentenceBreak(window, minChars);
      if (sentenceIdx >= minChars) return sentenceIdx;
    }

    const whitespaceIdx = findWhitespaceBreak(window, minChars);
    if (whitespaceIdx >= minChars) return whitespaceIdx;

    if (buffer.length >= maxChars) return maxChars;
    return -1;
  };

  const emitBlockChunk = (text: string) => {
    const chunk = text.trimEnd();
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

  const drainBlockBuffer = (force: boolean) => {
    if (!blockChunking) return;
    const minChars = Math.max(1, Math.floor(blockChunking.minChars));
    const maxChars = Math.max(minChars, Math.floor(blockChunking.maxChars));
    if (force && blockBuffer.length > 0 && blockBuffer.length <= maxChars) {
      emitBlockChunk(blockBuffer);
      blockBuffer = "";
      return;
    }
    if (blockBuffer.length < minChars && !force) return;
    while (blockBuffer.length >= minChars || (force && blockBuffer.length > 0)) {
      const breakIdx = pickBreakIndex(blockBuffer);
      if (breakIdx <= 0) {
        if (force) {
          emitBlockChunk(blockBuffer);
          blockBuffer = "";
        }
        return;
      }
      const rawChunk = blockBuffer.slice(0, breakIdx);
      if (rawChunk.trim().length === 0) {
        blockBuffer = blockBuffer.slice(breakIdx).trimStart();
        continue;
      }
      emitBlockChunk(rawChunk);
      const nextStart =
        breakIdx < blockBuffer.length && /\s/.test(blockBuffer[breakIdx])
          ? breakIdx + 1
          : breakIdx;
      blockBuffer = blockBuffer.slice(nextStart).trimStart();
      if (blockBuffer.length < minChars && !force) return;
      if (blockBuffer.length < maxChars && !force) return;
    }
  };

  const resetForCompactionRetry = () => {
    assistantTexts.length = 0;
    toolMetas.length = 0;
    toolMetaById.clear();
    deltaBuffer = "";
    blockBuffer = "";
    lastStreamedAssistant = undefined;
    lastBlockReplyText = undefined;
    assistantTextBaseline = 0;
    toolDebouncer.flush();
  };

  const unsubscribe = params.session.subscribe(
    (evt: AgentEvent | { type: string; [k: string]: unknown }) => {
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
        defaultRuntime.log?.(
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
        toolDebouncer.push(toolName, meta);

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

        const emitToolResult =
          typeof params.shouldEmitToolResult === "function"
            ? params.shouldEmitToolResult()
            : params.verboseLevel === "on";
        if (emitToolResult && params.onToolResult) {
          const agg = formatToolAggregate(toolName, meta ? [meta] : undefined);
          const { text: cleanedText, mediaUrls } = splitMediaFromOutput(agg);
          if (cleanedText || (mediaUrls && mediaUrls.length > 0)) {
            try {
              void params.onToolResult({
                text: cleanedText,
                mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
              });
            } catch {
              // ignore tool result delivery failures
            }
          }
        }
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
              blockBuffer += chunk;
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

            if (params.onBlockReply && blockChunking) {
              drainBlockBuffer(false);
            }

            if (evtType === "text_end" && blockReplyBreak === "text_end") {
              if (blockChunking && blockBuffer.length > 0) {
                drainBlockBuffer(true);
              } else if (next && next !== lastBlockReplyText) {
                lastBlockReplyText = next || undefined;
                if (next) assistantTexts.push(next);
                if (next && params.onBlockReply) {
                  const { text: cleanedText, mediaUrls } =
                    splitMediaFromOutput(next);
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
              lastStreamedAssistant = undefined;
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
          if (!addedDuringMessage && text) assistantTexts.push(text);
          assistantTextBaseline = assistantTexts.length;

          if (
            (blockReplyBreak === "message_end" || blockBuffer.length > 0) &&
            text &&
            params.onBlockReply
          ) {
            if (blockChunking && blockBuffer.length > 0) {
              drainBlockBuffer(true);
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
          lastStreamedAssistant = undefined;
          lastBlockReplyText = undefined;
        }
      }

      if (evt.type === "tool_execution_end") {
        const toolName = String(
          (evt as AgentEvent & { toolName: string }).toolName,
        );
        const toolCallId = String(
          (evt as AgentEvent & { toolCallId: string }).toolCallId,
        );
        defaultRuntime.log?.(
          `embedded run tool end: runId=${params.runId} tool=${toolName} toolCallId=${toolCallId}`,
        );
      }

      if (evt.type === "agent_start") {
        defaultRuntime.log?.(`embedded run agent start: runId=${params.runId}`);
      }

      if (evt.type === "auto_compaction_start") {
        compactionInFlight = true;
        ensureCompactionPromise();
        defaultRuntime.log?.(
          `embedded run compaction start: runId=${params.runId}`,
        );
      }

      if (evt.type === "auto_compaction_end") {
        compactionInFlight = false;
        const willRetry = Boolean((evt as { willRetry?: unknown }).willRetry);
        if (willRetry) {
          noteCompactionRetry();
          resetForCompactionRetry();
          defaultRuntime.log?.(
            `embedded run compaction retry: runId=${params.runId}`,
          );
        } else {
          maybeResolveCompactionWait();
        }
      }

      if (evt.type === "agent_end") {
        defaultRuntime.log?.(`embedded run agent end: runId=${params.runId}`);
        toolDebouncer.flush();
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
    flush: () => toolDebouncer.flush(),
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
