import fs from "node:fs";
import path from "node:path";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { ReasoningLevel } from "../auto-reply/thinking.js";
import { formatToolAggregate } from "../auto-reply/tool-meta.js";
import { resolveStateDir } from "../config/paths.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { truncateUtf16Safe } from "../utils.js";
import type { BlockReplyChunking } from "./pi-embedded-block-chunker.js";
import { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";
import { isMessagingToolDuplicate } from "./pi-embedded-helpers.js";
import {
  extractAssistantText,
  extractAssistantThinking,
  formatReasoningMarkdown,
  inferToolMetaFromArgs,
} from "./pi-embedded-utils.js";

const THINKING_TAG_RE = /<\s*\/?\s*think(?:ing)?\s*>/gi;
const THINKING_OPEN_RE = /<\s*think(?:ing)?\s*>/i;
const THINKING_CLOSE_RE = /<\s*\/\s*think(?:ing)?\s*>/i;
const THINKING_OPEN_GLOBAL_RE = /<\s*think(?:ing)?\s*>/gi;
const THINKING_CLOSE_GLOBAL_RE = /<\s*\/\s*think(?:ing)?\s*>/gi;
const THINKING_TAG_SCAN_RE = /<\s*(\/?)\s*think(?:ing)?\s*>/gi;
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

type MessagingToolSend = {
  tool: string;
  provider: string;
  accountId?: string;
  to?: string;
};

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

type ThinkTaggedSplitBlock =
  | { type: "thinking"; thinking: string }
  | { type: "text"; text: string };

function splitThinkingTaggedText(text: string): ThinkTaggedSplitBlock[] | null {
  const trimmedStart = text.trimStart();
  // Avoid false positives: only treat it as structured thinking when it begins
  // with a think tag (common for local/OpenAI-compat providers that emulate
  // reasoning blocks via tags).
  if (!trimmedStart.startsWith("<")) return null;
  if (!THINKING_OPEN_RE.test(trimmedStart)) return null;
  if (!THINKING_CLOSE_RE.test(text)) return null;

  THINKING_TAG_SCAN_RE.lastIndex = 0;
  let inThinking = false;
  let cursor = 0;
  let thinkingStart = 0;
  const blocks: ThinkTaggedSplitBlock[] = [];

  const pushText = (value: string) => {
    if (!value) return;
    blocks.push({ type: "text", text: value });
  };
  const pushThinking = (value: string) => {
    const cleaned = value.trim();
    if (!cleaned) return;
    blocks.push({ type: "thinking", thinking: cleaned });
  };

  for (const match of text.matchAll(THINKING_TAG_SCAN_RE)) {
    const index = match.index ?? 0;
    const isClose = Boolean(match[1]?.includes("/"));

    if (!inThinking && !isClose) {
      pushText(text.slice(cursor, index));
      thinkingStart = index + match[0].length;
      inThinking = true;
      continue;
    }

    if (inThinking && isClose) {
      pushThinking(text.slice(thinkingStart, index));
      cursor = index + match[0].length;
      inThinking = false;
    }
  }

  if (inThinking) return null;
  pushText(text.slice(cursor));

  const hasThinking = blocks.some((b) => b.type === "thinking");
  if (!hasThinking) return null;
  return blocks;
}

function promoteThinkingTagsToBlocks(message: AssistantMessage): void {
  if (!Array.isArray(message.content)) return;
  const hasThinkingBlock = message.content.some(
    (block) => block.type === "thinking",
  );
  if (hasThinkingBlock) return;

  const next: AssistantMessage["content"] = [];
  let changed = false;

  for (const block of message.content) {
    if (block.type !== "text") {
      next.push(block);
      continue;
    }
    const split = splitThinkingTaggedText(block.text);
    if (!split) {
      next.push(block);
      continue;
    }
    changed = true;
    for (const part of split) {
      if (part.type === "thinking") {
        next.push({ type: "thinking", thinking: part.thinking });
      } else if (part.type === "text") {
        const cleaned = part.text.trimStart();
        if (cleaned) next.push({ type: "text", text: cleaned });
      }
    }
  }

  if (!changed) return;
  message.content = next;
}

function normalizeSlackTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const mentionMatch = trimmed.match(/^<@([A-Z0-9]+)>$/i);
  if (mentionMatch) return `user:${mentionMatch[1]}`;
  if (trimmed.startsWith("user:")) {
    const id = trimmed.slice(5).trim();
    return id ? `user:${id}` : undefined;
  }
  if (trimmed.startsWith("channel:")) {
    const id = trimmed.slice(8).trim();
    return id ? `channel:${id}` : undefined;
  }
  if (trimmed.startsWith("slack:")) {
    const id = trimmed.slice(6).trim();
    return id ? `user:${id}` : undefined;
  }
  if (trimmed.startsWith("@")) {
    const id = trimmed.slice(1).trim();
    return id ? `user:${id}` : undefined;
  }
  if (trimmed.startsWith("#")) {
    const id = trimmed.slice(1).trim();
    return id ? `channel:${id}` : undefined;
  }
  return `channel:${trimmed}`;
}

function normalizeDiscordTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const mentionMatch = trimmed.match(/^<@!?(\d+)>$/);
  if (mentionMatch) return `user:${mentionMatch[1]}`;
  if (trimmed.startsWith("user:")) {
    const id = trimmed.slice(5).trim();
    return id ? `user:${id}` : undefined;
  }
  if (trimmed.startsWith("channel:")) {
    const id = trimmed.slice(8).trim();
    return id ? `channel:${id}` : undefined;
  }
  if (trimmed.startsWith("discord:")) {
    const id = trimmed.slice(8).trim();
    return id ? `user:${id}` : undefined;
  }
  if (trimmed.startsWith("@")) {
    const id = trimmed.slice(1).trim();
    return id ? `user:${id}` : undefined;
  }
  return `channel:${trimmed}`;
}

function normalizeTelegramTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let normalized = trimmed;
  if (normalized.startsWith("telegram:")) {
    normalized = normalized.slice("telegram:".length).trim();
  } else if (normalized.startsWith("tg:")) {
    normalized = normalized.slice("tg:".length).trim();
  } else if (normalized.startsWith("group:")) {
    normalized = normalized.slice("group:".length).trim();
  }
  if (!normalized) return undefined;
  const tmeMatch =
    /^https?:\/\/t\.me\/([A-Za-z0-9_]+)$/i.exec(normalized) ??
    /^t\.me\/([A-Za-z0-9_]+)$/i.exec(normalized);
  if (tmeMatch?.[1]) normalized = `@${tmeMatch[1]}`;
  if (!normalized) return undefined;
  return `telegram:${normalized}`;
}

function extractMessagingToolSend(
  toolName: string,
  args: Record<string, unknown>,
): MessagingToolSend | undefined {
  const action = typeof args.action === "string" ? args.action.trim() : "";
  const accountIdRaw =
    typeof args.accountId === "string" ? args.accountId.trim() : undefined;
  const accountId = accountIdRaw ? accountIdRaw : undefined;
  if (toolName === "slack") {
    if (action !== "sendMessage") return undefined;
    const toRaw = typeof args.to === "string" ? args.to : undefined;
    if (!toRaw) return undefined;
    const to = normalizeSlackTarget(toRaw);
    return to
      ? { tool: toolName, provider: "slack", accountId, to }
      : undefined;
  }
  if (toolName === "discord") {
    if (action === "sendMessage") {
      const toRaw = typeof args.to === "string" ? args.to : undefined;
      if (!toRaw) return undefined;
      const to = normalizeDiscordTarget(toRaw);
      return to
        ? { tool: toolName, provider: "discord", accountId, to }
        : undefined;
    }
    if (action === "threadReply") {
      const channelId =
        typeof args.channelId === "string" ? args.channelId.trim() : "";
      if (!channelId) return undefined;
      const to = normalizeDiscordTarget(`channel:${channelId}`);
      return to
        ? { tool: toolName, provider: "discord", accountId, to }
        : undefined;
    }
    return undefined;
  }
  if (toolName === "telegram") {
    if (action !== "sendMessage") return undefined;
    const toRaw = typeof args.to === "string" ? args.to : undefined;
    if (!toRaw) return undefined;
    const to = normalizeTelegramTarget(toRaw);
    return to
      ? { tool: toolName, provider: "telegram", accountId, to }
      : undefined;
  }
  return undefined;
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
  const streamReasoning =
    reasoningMode === "stream" &&
    typeof params.onReasoningStream === "function";
  let deltaBuffer = "";
  let blockBuffer = "";
  let lastStreamedAssistant: string | undefined;
  let lastStreamedReasoning: string | undefined;
  let lastBlockReplyText: string | undefined;
  let assistantTextBaseline = 0;
  let compactionInFlight = false;
  let pendingCompactionRetry = 0;
  let compactionRetryResolve: (() => void) | undefined;
  let compactionRetryPromise: Promise<void> | null = null;
  let lastReasoningSent: string | undefined;

  // ── Messaging tool duplicate detection ──────────────────────────────────────
  // Track texts sent via messaging tools to suppress duplicate block replies.
  // Only committed (successful) texts are checked - pending texts are tracked
  // to support commit logic but not used for suppression (avoiding lost messages on tool failure).
  // These tools can send messages via sendMessage/threadReply actions (or sessions_send with message).
  const MESSAGING_TOOLS = new Set([
    "telegram",
    "whatsapp",
    "discord",
    "slack",
    "sessions_send",
  ]);
  const messagingToolSentTexts: string[] = [];
  const messagingToolSentTargets: MessagingToolSend[] = [];
  const pendingMessagingTexts = new Map<string, string>();
  const pendingMessagingTargets = new Map<string, MessagingToolSend>();

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

    // Only check committed (successful) messaging tool texts - checking pending texts
    // is risky because if the tool fails after suppression, the user gets no response
    if (isMessagingToolDuplicate(chunk, messagingToolSentTexts)) {
      log.debug(
        `Skipping block reply - already sent via messaging tool: ${chunk.slice(0, 50)}...`,
      );
      return;
    }

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

  const extractThinkingFromText = (text: string): string => {
    if (!text || !THINKING_TAG_RE.test(text)) return "";
    THINKING_TAG_RE.lastIndex = 0;
    let result = "";
    let lastIndex = 0;
    let inThinking = false;
    for (const match of text.matchAll(THINKING_TAG_RE)) {
      const idx = match.index ?? 0;
      if (inThinking) {
        result += text.slice(lastIndex, idx);
      }
      const tag = match[0].toLowerCase();
      inThinking = !tag.includes("/");
      lastIndex = idx + match[0].length;
    }
    return result.trim();
  };

  const extractThinkingFromStream = (text: string): string => {
    if (!text) return "";
    const closed = extractThinkingFromText(text);
    if (closed) return closed;
    const openMatches = [...text.matchAll(THINKING_OPEN_GLOBAL_RE)];
    if (openMatches.length === 0) return "";
    const closeMatches = [...text.matchAll(THINKING_CLOSE_GLOBAL_RE)];
    const lastOpen = openMatches[openMatches.length - 1];
    const lastClose = closeMatches[closeMatches.length - 1];
    if (lastClose && (lastClose.index ?? -1) > (lastOpen.index ?? -1)) {
      return closed;
    }
    const start = (lastOpen.index ?? 0) + lastOpen[0].length;
    return text.slice(start).trim();
  };

  const formatReasoningDraft = (text: string): string => {
    const trimmed = text.trim();
    if (!trimmed) return "";
    return `Reasoning:\n${trimmed}`;
  };

  const emitReasoningStream = (text: string) => {
    if (!streamReasoning || !params.onReasoningStream) return;
    const formatted = formatReasoningDraft(text);
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
    messagingToolSentTargets.length = 0;
    pendingMessagingTexts.clear();
    pendingMessagingTargets.clear();
    deltaBuffer = "";
    blockBuffer = "";
    blockChunker?.reset();
    lastStreamedAssistant = undefined;
    lastStreamedReasoning = undefined;
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
          lastStreamedReasoning = undefined;
          lastReasoningSent = undefined;
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

        // Track messaging tool sends (pending until confirmed in tool_execution_end)
        if (MESSAGING_TOOLS.has(toolName)) {
          const argsRecord =
            args && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {};
          const action =
            typeof argsRecord.action === "string" ? argsRecord.action : "";
          // Track send actions: sendMessage/threadReply for Discord/Slack, or sessions_send (no action field)
          if (
            action === "sendMessage" ||
            action === "threadReply" ||
            toolName === "sessions_send"
          ) {
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
          if (!isError) {
            messagingToolSentTexts.push(pendingText);
            log.debug(
              `Committed messaging text: tool=${toolName} len=${pendingText.length}`,
            );
          }
        }
        if (pendingTarget) {
          pendingMessagingTargets.delete(toolCallId);
          if (!isError) {
            messagingToolSentTargets.push(pendingTarget);
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
              emitReasoningStream(extractThinkingFromStream(deltaBuffer));
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
                extractThinkingFromText(rawText)
              : "";
          const formattedReasoning = rawThinking
            ? formatReasoningMarkdown(rawThinking)
            : "";
          const text = includeReasoning
            ? baseText && formattedReasoning
              ? `${formattedReasoning}\n\n${baseText}`
              : formattedReasoning || baseText
            : baseText;

          const addedDuringMessage =
            assistantTexts.length > assistantTextBaseline;
          const chunkerHasBuffered = blockChunker?.hasBuffered() ?? false;
          // Non-streaming models (no text_delta): ensure assistantTexts gets the
          // final text when the chunker has nothing buffered to drain.
          if (!addedDuringMessage && !chunkerHasBuffered && text) {
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
              // Check for duplicates before emitting (same logic as emitBlockChunk)
              if (isMessagingToolDuplicate(text, messagingToolSentTexts)) {
                log.debug(
                  `Skipping message_end block reply - already sent via messaging tool: ${text.slice(0, 50)}...`,
                );
              } else {
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
          }
          const onBlockReply = params.onBlockReply;
          const shouldEmitReasoningBlock =
            includeReasoning &&
            Boolean(formattedReasoning) &&
            Boolean(onBlockReply) &&
            formattedReasoning !== lastReasoningSent &&
            (blockReplyBreak === "text_end" || Boolean(blockChunker));
          if (shouldEmitReasoningBlock && formattedReasoning && onBlockReply) {
            lastReasoningSent = formattedReasoning;
            void onBlockReply({ text: formattedReasoning });
          }
          if (streamReasoning && rawThinking) {
            emitReasoningStream(rawThinking);
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
