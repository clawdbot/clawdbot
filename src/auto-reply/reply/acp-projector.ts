import type { AcpRuntimeEvent, AcpSessionUpdateTag } from "../../acp/runtime/types.js";
import { EmbeddedBlockChunker } from "../../agents/pi-embedded-block-chunker.js";
import { formatToolSummary, resolveToolDisplay } from "../../agents/tool-display.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prefixSystemMessage } from "../../infra/system-message.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import type { ReplyPayload } from "../types.js";
import {
  type AcpHiddenBoundarySeparator,
  isAcpTagVisible,
  resolveAcpProjectionSettings,
  resolveAcpStreamingConfig,
} from "./acp-stream-settings.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";

const ACP_BLOCK_REPLY_TIMEOUT_MS = 15_000;
const ACP_LIVE_IDLE_FLUSH_FLOOR_MS = 750;
const ACP_LIVE_IDLE_MIN_CHARS = 80;
const ACP_LIVE_SOFT_FLUSH_CHARS = 220;
const ACP_LIVE_HARD_FLUSH_CHARS = 480;

const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed", "cancelled", "done", "error"]);
const HIDDEN_BOUNDARY_TAGS = new Set<AcpSessionUpdateTag>(["tool_call", "tool_call_update"]);

export type AcpProjectedDeliveryMeta = {
  tag?: AcpSessionUpdateTag;
  toolCallId?: string;
  toolStatus?: string;
  allowEdit?: boolean;
};

type ToolLifecycleState = {
  started: boolean;
  terminal: boolean;
  lastRenderedHash?: string;
};

type BufferedToolDelivery = {
  payload: ReplyPayload;
  meta?: AcpProjectedDeliveryMeta;
};

function truncateText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  if (maxChars <= 1) {
    return input.slice(0, maxChars);
  }
  return `${input.slice(0, maxChars - 1)}…`;
}

function hashText(text: string): string {
  return text.trim();
}

function normalizeToolStatus(status: string | undefined): string | undefined {
  const normalized = normalizeOptionalLowercaseString(status);
  return normalized || undefined;
}

function resolveHiddenBoundarySeparatorText(mode: AcpHiddenBoundarySeparator): string {
  if (mode === "space") {
    return " ";
  }
  if (mode === "newline") {
    return "\n";
  }
  if (mode === "paragraph") {
    return "\n\n";
  }
  return "";
}

function shouldInsertSeparator(params: {
  separator: string;
  previousTail: string | undefined;
  nextText: string;
}): boolean {
  if (!params.separator) {
    return false;
  }
  if (!params.nextText) {
    return false;
  }
  const firstChar = params.nextText[0];
  if (typeof firstChar === "string" && /\s/.test(firstChar)) {
    return false;
  }
  const tail = params.previousTail ?? "";
  if (!tail) {
    return false;
  }
  if (params.separator === " " && /\s$/.test(tail)) {
    return false;
  }
  if ((params.separator === "\n" || params.separator === "\n\n") && tail.endsWith("\n")) {
    return false;
  }
  return true;
}

function shouldFlushLiveBufferOnBoundary(text: string): boolean {
  if (!text) {
    return false;
  }
  if (text.length >= ACP_LIVE_HARD_FLUSH_CHARS) {
    return true;
  }
  if (text.endsWith("\n\n")) {
    return true;
  }
  if (/[.!?][)"'`]*\s$/.test(text)) {
    return true;
  }
  if (text.length >= ACP_LIVE_SOFT_FLUSH_CHARS && /\s$/.test(text)) {
    return true;
  }
  return false;
}

function shouldFlushLiveBufferOnIdle(text: string): boolean {
  if (!text) {
    return false;
  }
  if (text.length >= ACP_LIVE_IDLE_MIN_CHARS) {
    return true;
  }
  if (/[.!?][)"'`]*$/.test(text.trimEnd())) {
    return true;
  }
  if (text.includes("\n")) {
    return true;
  }
  return false;
}

function renderToolSummaryText(event: Extract<AcpRuntimeEvent, { type: "tool_call" }>): string {
  const detailParts: string[] = [];
  const title = normalizeOptionalString(event.title);
  if (title) {
    detailParts.push(title);
  }
  const status = normalizeOptionalString(event.status);
  if (status) {
    detailParts.push(`status=${status}`);
  }
  const fallback = normalizeOptionalString(event.text);
  if (detailParts.length === 0 && fallback) {
    detailParts.push(fallback);
  }
  const display = resolveToolDisplay({
    name: "tool_call",
    meta: detailParts.join(" · ") || "tool call",
  });
  return formatToolSummary(display);
}

export type AcpReplyProjector = {
  onEvent: (event: AcpRuntimeEvent) => Promise<void>;
  flush: (force?: boolean) => Promise<void>;
};

export function createAcpReplyProjector(params: {
  cfg: OpenClawConfig;
  shouldSendToolSummaries: boolean;
  deliver: (
    kind: ReplyDispatchKind,
    payload: ReplyPayload,
    meta?: AcpProjectedDeliveryMeta,
  ) => Promise<boolean>;
  provider?: string;
  accountId?: string;
}): AcpReplyProjector {
  const settings = resolveAcpProjectionSettings(params.cfg);
  const streaming = resolveAcpStreamingConfig({
    cfg: params.cfg,
    provider: params.provider,
    accountId: params.accountId,
    deliveryMode: settings.deliveryMode,
  });
  const createTurnBlockReplyPipeline = () =>
    createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        await params.deliver("block", payload);
      },
      timeoutMs: ACP_BLOCK_REPLY_TIMEOUT_MS,
      coalescing: settings.deliveryMode === "live" ? undefined : streaming.coalescing,
    });
  let blockReplyPipeline = createTurnBlockReplyPipeline();
  const chunker = new EmbeddedBlockChunker(streaming.chunking);
  const liveIdleFlushMs = Math.max(streaming.coalescing.idleMs, ACP_LIVE_IDLE_FLUSH_FLOOR_MS);

  let emittedOutputChars = 0;
  let truncationNoticeEmitted = false;
  let lastStatusHash: string | undefined;
  let lastToolHash: string | undefined;
  let lastUsageTuple: string | undefined;
  let lastVisibleOutputTail: string | undefined;
  let pendingHiddenBoundary = false;
  let liveBufferText = "";
  let liveIdleTimer: NodeJS.Timeout | undefined;
  const pendingToolDeliveries: BufferedToolDelivery[] = [];
  const toolLifecycleById = new Map<string, ToolLifecycleState>();

  const clearLiveIdleTimer = () => {
    if (!liveIdleTimer) {
      return;
    }
    clearTimeout(liveIdleTimer);
    liveIdleTimer = undefined;
  };

  const drainChunker = (force: boolean) => {
    if (settings.deliveryMode === "final_only" && !force) {
      return;
    }
    chunker.drain({
      force,
      emit: (chunk) => {
        blockReplyPipeline.enqueue({ text: chunk });
      },
    });
  };

  const flushLiveBuffer = (opts?: { force?: boolean; idle?: boolean }) => {
    if (settings.deliveryMode !== "live") {
      return;
    }
    if (!liveBufferText) {
      return;
    }
    if (opts?.idle && !shouldFlushLiveBufferOnIdle(liveBufferText)) {
      return;
    }
    const text = liveBufferText;
    liveBufferText = "";
    chunker.append(text);
    drainChunker(opts?.force === true);
  };

  const scheduleLiveIdleFlush = () => {
    if (settings.deliveryMode !== "live") {
      return;
    }
    if (liveIdleFlushMs <= 0 || !liveBufferText) {
      return;
    }
    clearLiveIdleTimer();
    liveIdleTimer = setTimeout(() => {
      flushLiveBuffer({ force: true, idle: true });
      if (liveBufferText) {
        scheduleLiveIdleFlush();
      }
    }, liveIdleFlushMs);
  };

  const resetTurnState = () => {
    clearLiveIdleTimer();
    blockReplyPipeline.stop();
    blockReplyPipeline = createTurnBlockReplyPipeline();
    emittedOutputChars = 0;
    truncationNoticeEmitted = false;
    lastStatusHash = undefined;
    lastToolHash = undefined;
    lastUsageTuple = undefined;
    lastVisibleOutputTail = undefined;
    pendingHiddenBoundary = false;
    liveBufferText = "";
    pendingToolDeliveries.length = 0;
    toolLifecycleById.clear();
  };

  const flushBufferedToolDeliveries = async (force: boolean) => {
    if (!(settings.deliveryMode === "final_only" && force)) {
      return;
    }
    for (const entry of pendingToolDeliveries.splice(0)) {
      await params.deliver("tool", entry.payload, entry.meta);
    }
  };

  const flush = async (force = false): Promise<void> => {
    if (settings.deliveryMode === "live") {
      clearLiveIdleTimer();
      flushLiveBuffer({ force: true });
    }
    await flushBufferedToolDeliveries(force);
    drainChunker(force);
    await blockReplyPipeline.flush({ force });
  };

  const emitSystemStatus = async (
    text: string,
    meta?: AcpProjectedDeliveryMeta,
    opts?: { dedupe?: boolean },
  ) => {
    if (!params.shouldSendToolSummaries) {
      return;
    }
    const bounded = truncateText(text.trim(), settings.maxSessionUpdateChars);
    if (!bounded) {
      return;
    }
    const formatted = prefixSystemMessage(bounded);
    const hash = hashText(formatted);
    const shouldDedupe = settings.repeatSuppression && opts?.dedupe !== false;
    if (shouldDedupe && lastStatusHash === hash) {
      return;
    }
    if (settings.deliveryMode === "final_only") {
      pendingToolDeliveries.push({
        payload: { text: formatted },
        meta,
      });
    } else {
      await flush(true);
      await params.deliver("tool", { text: formatted }, meta);
    }
    lastStatusHash = hash;
  };

  const emitToolSummary = async (event: Extract<AcpRuntimeEvent, { type: "tool_call" }>) => {
    if (!params.shouldSendToolSummaries) {
      return;
    }
    if (!isAcpTagVisible(settings, event.tag)) {
      return;
    }

    const renderedToolSummary = renderToolSummaryText(event);
    const toolSummary = truncateText(renderedToolSummary, settings.maxSessionUpdateChars);
    const hash = hashText(renderedToolSummary);
    const toolCallId = normalizeOptionalString(event.toolCallId);
    const status = normalizeToolStatus(event.status);
    const isTerminal = status ? TERMINAL_TOOL_STATUSES.has(status) : false;
    const isStart = status === "in_progress" || event.tag === "tool_call";

    if (settings.repeatSuppression) {
      if (toolCallId) {
        const state = toolLifecycleById.get(toolCallId) ?? {
          started: false,
          terminal: false,
        };
        if (isTerminal && state.terminal) {
          return;
        }
        if (isStart && state.started) {
          return;
        }
        if (state.lastRenderedHash === hash) {
          return;
        }
        if (isStart) {
          state.started = true;
        }
        if (isTerminal) {
          state.terminal = true;
        }
        state.lastRenderedHash = hash;
        toolLifecycleById.set(toolCallId, state);
      } else if (lastToolHash === hash) {
        return;
      }
    }

    const deliveryMeta: AcpProjectedDeliveryMeta = {
      ...(event.tag ? { tag: event.tag } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(status ? { toolStatus: status } : {}),
      allowEdit: Boolean(toolCallId && event.tag === "tool_call_update"),
    };
    if (settings.deliveryMode === "final_only") {
      pendingToolDeliveries.push({
        payload: { text: toolSummary },
        meta: deliveryMeta,
      });
    } else {
      await flush(true);
      await params.deliver("tool", { text: toolSummary }, deliveryMeta);
    }
    lastToolHash = hash;
  };

  const emitTruncationNotice = async () => {
    if (truncationNoticeEmitted) {
      return;
    }
    truncationNoticeEmitted = true;
    await emitSystemStatus(
      "output truncated",
      {
        tag: "session_info_update",
      },
      {
        dedupe: false,
      },
    );
  };

  const onEvent = async (event: AcpRuntimeEvent): Promise<void> => {
    if (event.type === "text_delta") {
      if (event.stream && event.stream !== "output") {
        return;
      }
      if (!isAcpTagVisible(settings, event.tag)) {
        return;
      }
      let text = event.text;
      if (!text) {
        return;
      }
      if (
        pendingHiddenBoundary &&
        shouldInsertSeparator({
          separator: resolveHiddenBoundarySeparatorText(settings.hiddenBoundarySeparator),
          previousTail: lastVisibleOutputTail,
          nextText: text,
        })
      ) {
        text = `${resolveHiddenBoundarySeparatorText(settings.hiddenBoundarySeparator)}${text}`;
      }
      pendingHiddenBoundary = false;
      if (emittedOutputChars >= settings.maxOutputChars) {
        await emitTruncationNotice();
        return;
      }
      const remaining = settings.maxOutputChars - emittedOutputChars;
      const accepted = remaining < text.length ? text.slice(0, remaining) : text;
      if (accepted.length > 0) {
        emittedOutputChars += accepted.length;
        lastVisibleOutputTail = accepted.slice(-1);
        if (settings.deliveryMode === "live") {
          liveBufferText += accepted;
          if (shouldFlushLiveBufferOnBoundary(liveBufferText)) {
            clearLiveIdleTimer();
            flushLiveBuffer({ force: true });
          } else {
            scheduleLiveIdleFlush();
          }
        } else {
          chunker.append(accepted);
          drainChunker(false);
        }
      }
      if (accepted.length < text.length) {
        await emitTruncationNotice();
      }
      return;
    }

    if (event.type === "status") {
      if (!isAcpTagVisible(settings, event.tag)) {
        return;
      }
      if (event.tag === "usage_update" && settings.repeatSuppression) {
        const usageTuple =
          typeof event.used === "number" && typeof event.size === "number"
            ? `${event.used}/${event.size}`
            : hashText(event.text);
        if (usageTuple === lastUsageTuple) {
          return;
        }
        lastUsageTuple = usageTuple;
      }
      await emitSystemStatus(event.text, event.tag ? { tag: event.tag } : undefined, {
        dedupe: true,
      });
      return;
    }

    if (event.type === "tool_call") {
      if (!isAcpTagVisible(settings, event.tag)) {
        if (event.tag && HIDDEN_BOUNDARY_TAGS.has(event.tag)) {
          const status = normalizeToolStatus(event.status);
          const isTerminal = status ? TERMINAL_TOOL_STATUSES.has(status) : false;
          pendingHiddenBoundary = pendingHiddenBoundary || event.tag === "tool_call" || isTerminal;
        }
        return;
      }
      await emitToolSummary(event);
      return;
    }

    if (event.type === "done" || event.type === "error") {
      await flush(true);
      resetTurnState();
    }
  };

  return {
    onEvent,
    flush,
  };
}
