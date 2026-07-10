// Mattermost plugin module implements draft stream behavior.
import {
  clearFinalizableDraftMessage,
  createFinalizableDraftLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  createMattermostPost,
  deleteMattermostPost,
  updateMattermostPost,
  type MattermostClient,
} from "./client.js";

const MATTERMOST_STREAM_MAX_CHARS = 4000;
const DEFAULT_THROTTLE_MS = 1000;

type MattermostFinalTextResolution =
  | { kind: "full"; text: string }
  | { kind: "remaining"; text: string }
  | { kind: "already-delivered" };

type MattermostDraftStream = {
  update: (text: string) => void;
  updateAssistantText: (text: string) => void;
  flush: () => Promise<void>;
  postId: () => string | undefined;
  clear: () => Promise<void>;
  discardPending: () => Promise<void>;
  seal: () => Promise<void>;
  stop: () => Promise<void>;
  forceNewMessage: () => Promise<void>;
  settleBoundaries: () => Promise<void>;
  resolveFinalText: (text: string) => MattermostFinalTextResolution;
};

function normalizeMattermostDraftText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${sliceUtf16Safe(trimmed, 0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export type MattermostDraftPreviewBoundaryController = {
  noteUpdate: () => void;
  noteBoundary: () => Promise<void>;
};

export function createMattermostDraftPreviewBoundaryController(params: {
  enabled: boolean;
  forceNewMessage: () => void | Promise<void>;
}): MattermostDraftPreviewBoundaryController {
  let hasStreamedContent = false;
  return {
    noteUpdate() {
      hasStreamedContent = true;
    },
    async noteBoundary() {
      if (!params.enabled) {
        return;
      }
      if (!hasStreamedContent) {
        return;
      }
      hasStreamedContent = false;
      await params.forceNewMessage();
    },
  };
}

export function createMattermostDraftStream(params: {
  client: MattermostClient;
  channelId: string;
  rootId?: string;
  maxChars?: number;
  throttleMs?: number;
  renderText?: (text: string) => string;
  chunkText?: (text: string) => string[];
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): MattermostDraftStream {
  const maxChars = Math.min(
    params.maxChars ?? MATTERMOST_STREAM_MAX_CHARS,
    MATTERMOST_STREAM_MAX_CHARS,
  );
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const streamState = { stopped: false, final: false };
  type DraftGeneration = {
    postId?: string;
    lastSentText: string;
    // A boundary can arrive after pending text flushed. Keep the full source so sealing can
    // replace the ellipsized preview with lossless chunks instead of retaining truncation.
    latestSourceText: string;
    latestAssistantText?: string;
    ready: Promise<void>;
  };
  let currentGeneration: DraftGeneration = {
    lastSentText: "",
    latestSourceText: "",
    ready: Promise.resolve(),
  };
  const sealedAssistantTexts: string[] = [];

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    const target = currentGeneration;
    const rendered = params.renderText?.(text) ?? text;
    const normalized = normalizeMattermostDraftText(rendered, maxChars);
    if (!normalized) {
      return false;
    }
    await target.ready;
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    if (normalized === target.lastSentText) {
      return true;
    }
    try {
      if (target.postId) {
        await updateMattermostPost(params.client, target.postId, {
          message: normalized,
        });
      } else {
        const sent = await createMattermostPost(params.client, {
          channelId: params.channelId,
          message: normalized,
          rootId: params.rootId,
        });
        const postId = sent.id?.trim();
        if (!postId) {
          streamState.stopped = true;
          params.warn?.("mattermost stream preview stopped (missing post id from create)");
          return false;
        }
        target.postId = postId;
      }
      target.lastSentText = normalized;
      return true;
    } catch (err) {
      streamState.stopped = true;
      params.warn?.(
        `mattermost stream preview failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  const clearMessageId = () => {
    currentGeneration.postId = undefined;
  };
  const isValidMessageId = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0;
  const deleteMessage = async (postId: string) => {
    await deleteMattermostPost(params.client, postId);
  };
  const {
    loop,
    update: updateLifecycle,
    stop: stopLifecycle,
    stopForClear,
    seal: sealLifecycle,
  } = createFinalizableDraftLifecycle({
    throttleMs,
    state: streamState,
    sendOrEditStreamMessage,
    readMessageId: () => currentGeneration.postId,
    clearMessageId,
    isValidMessageId,
    deleteMessage,
    warn: params.warn,
    warnPrefix: "mattermost stream preview cleanup failed",
  });

  const forceNewMessage = () => {
    if (streamState.stopped || streamState.final) {
      return Promise.resolve();
    }
    // Agent boundary callbacks are fire-and-forget. Swap generations synchronously; the new
    // generation waits for the old send and seal so posts stay in publication order.
    const pendingText = loop.takePending();
    const inFlightAtBoundary = loop.waitForInFlight();
    const sealed = currentGeneration;
    const boundary = (async () => {
      try {
        await sealed.ready;
        await inFlightAtBoundary;
        if (streamState.stopped && !streamState.final) {
          return;
        }
        const sourceText = pendingText.trim() ? pendingText : sealed.latestSourceText;
        const rendered = params.renderText?.(sourceText) ?? sourceText;
        const finalizedText = rendered.trim();
        const chunks =
          params.chunkText?.(finalizedText) ??
          chunkMarkdownTextWithMode(finalizedText, maxChars, "length");
        const firstChunk = chunks[0];
        if (!firstChunk) {
          return;
        }
        if (sealed.postId) {
          if (firstChunk !== sealed.lastSentText) {
            await updateMattermostPost(params.client, sealed.postId, { message: firstChunk });
          }
        } else {
          await createMattermostPost(params.client, {
            channelId: params.channelId,
            message: firstChunk,
            rootId: params.rootId,
          });
        }
        for (const chunk of chunks.slice(1)) {
          await createMattermostPost(params.client, {
            channelId: params.channelId,
            message: chunk,
            rootId: params.rootId,
          });
        }
        const assistantText = sealed.latestAssistantText?.trim();
        if (assistantText) {
          sealedAssistantTexts.push(assistantText);
        }
      } catch (err) {
        params.warn?.(
          `mattermost stream preview boundary flush failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
    currentGeneration = {
      lastSentText: "",
      latestSourceText: "",
      ready: boundary,
    };
    loop.resetThrottleWindow();
    return boundary;
  };

  const flush = async () => {
    await loop.flush();
    await currentGeneration.ready;
  };
  const discardPending = async () => {
    await stopForClear();
    await currentGeneration.ready;
  };
  const clear = async () => {
    await clearFinalizableDraftMessage({
      stopForClear: discardPending,
      readMessageId: () => currentGeneration.postId,
      clearMessageId,
      isValidMessageId,
      deleteMessage,
      warn: params.warn,
      warnPrefix: "mattermost stream preview cleanup failed",
    });
  };
  const seal = async () => {
    await sealLifecycle();
    await currentGeneration.ready;
  };
  const stop = async () => {
    await stopLifecycle();
    await currentGeneration.ready;
  };
  const update = (text: string) => {
    currentGeneration.latestSourceText = text;
    currentGeneration.latestAssistantText = undefined;
    updateLifecycle(text);
  };
  const updateAssistantText = (text: string) => {
    currentGeneration.latestSourceText = text;
    currentGeneration.latestAssistantText = text;
    updateLifecycle(text);
  };
  const settleBoundaries = async () => {
    await currentGeneration.ready;
  };
  const resolveFinalText = (text: string) => {
    if (sealedAssistantTexts.length === 0) {
      return { kind: "full" as const, text };
    }

    let remainingText = text.trim();
    for (const sealedText of sealedAssistantTexts) {
      const completed = sealedText.trim();
      if (!completed || !remainingText.startsWith(completed)) {
        return { kind: "full" as const, text };
      }
      const suffix = remainingText.slice(completed.length);
      // Canonical assistant block aggregation uses newline separators. A plain-space
      // suffix can be a block-local final that merely shares the prior block's prefix.
      if (suffix && !/^\r?\n/.test(suffix)) {
        return { kind: "full" as const, text };
      }
      remainingText = suffix.replace(/^(?:\r?\n)+/, "");
    }
    const currentText = currentGeneration.latestAssistantText?.trim() ?? "";
    const remaining = remainingText.trim();
    if (currentText && !remaining.startsWith(currentText)) {
      return { kind: "full" as const, text };
    }
    return remaining
      ? { kind: "remaining" as const, text: remaining }
      : { kind: "already-delivered" as const };
  };

  params.log?.(`mattermost stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    updateAssistantText,
    flush,
    postId: () => currentGeneration.postId,
    clear,
    discardPending,
    seal,
    stop,
    forceNewMessage,
    settleBoundaries,
    resolveFinalText,
  };
}
