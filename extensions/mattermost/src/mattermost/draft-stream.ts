// Mattermost plugin module implements draft stream behavior.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createFinalizableDraftLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
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

type MattermostDraftPublishedPart = {
  messageId: string;
  content: string;
};

type MattermostFinalTextResolution =
  | {
      kind: "full";
      text: string;
      publishedParts: readonly MattermostDraftPublishedPart[];
    }
  | {
      kind: "remaining";
      text: string;
      publishedParts: readonly MattermostDraftPublishedPart[];
    }
  | {
      kind: "already-delivered";
      publishedParts: readonly MattermostDraftPublishedPart[];
    };

type MattermostDraftStream = {
  update: (text: string) => void;
  updateAssistantText: (text: string) => void;
  flush: () => Promise<void>;
  postId: () => string | undefined;
  clear: () => Promise<void>;
  deleteCurrentMessage: () => Promise<void>;
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

function consumeMattermostPublishedChunk(params: {
  source: string;
  offset: number;
  chunk: string;
}): number | undefined {
  const chunk = params.chunk.trim();
  if (!chunk) {
    return params.offset;
  }
  let offset = params.offset;
  while (offset < params.source.length && /\s/.test(params.source[offset] ?? "")) {
    offset += 1;
  }
  return params.source.startsWith(chunk, offset) ? offset + chunk.length : undefined;
}

type MattermostDraftPreviewBoundaryController = {
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
  let terminalAcceptedDeliveryError: Error | undefined;
  const assertNoAcceptedDeliveryFailure = () => {
    if (terminalAcceptedDeliveryError !== undefined) {
      throw terminalAcceptedDeliveryError;
    }
  };
  type DraftGeneration = {
    postId?: string;
    lastSentText: string;
    lastProviderText?: string;
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
  const sealedAssistantTexts: Array<{ text: string; requiresBlockBoundary: boolean }> = [];
  const publishedAssistantParts = new Map<string, MattermostDraftPublishedPart>();
  const trackPublishedAssistantPart = (part: MattermostDraftPublishedPart) => {
    publishedAssistantParts.set(part.messageId, part);
  };

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
        const updated = await updateMattermostPost(params.client, target.postId, {
          message: normalized,
        });
        target.lastProviderText = updated.message ?? normalized;
      } else {
        const sent = await createMattermostPost(params.client, {
          channelId: params.channelId,
          message: normalized,
          rootId: params.rootId,
        });
        target.postId = sent.id;
        target.lastProviderText = sent.message ?? normalized;
      }
      target.lastSentText = normalized;
      return true;
    } catch (err) {
      // Stop immediately so a discarded background failure cannot queue a second visible post.
      streamState.stopped = true;
      const acceptedDeliveryError = isChannelPartialDeliveryError(err)
        ? toErrorObject(err, "Mattermost accepted delivery failed")
        : undefined;
      if (acceptedDeliveryError) {
        // Warning handlers can synchronously re-enter finalization; retain the failure first.
        terminalAcceptedDeliveryError = acceptedDeliveryError;
      }
      params.warn?.(
        `mattermost stream preview failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (acceptedDeliveryError) {
        throw acceptedDeliveryError;
      }
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
    clearWithStop,
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
    if (terminalAcceptedDeliveryError !== undefined) {
      return Promise.reject(terminalAcceptedDeliveryError);
    }
    if (streamState.stopped || streamState.final) {
      return Promise.resolve();
    }
    // Agent boundary callbacks are fire-and-forget. Swap generations synchronously; the new
    // generation waits for the old send and seal so posts stay in publication order.
    const pendingText = loop.takePending();
    const inFlightAtBoundary = loop.waitForInFlight();
    const sealed = currentGeneration;
    const assistantText = sealed.latestAssistantText?.trim();
    let publishedAssistantOffset = 0;
    const boundary = (async () => {
      try {
        await sealed.ready;
        assertNoAcceptedDeliveryFailure();
        await inFlightAtBoundary;
        assertNoAcceptedDeliveryFailure();
        if (streamState.stopped && !streamState.final) {
          assertNoAcceptedDeliveryFailure();
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
          if (assistantText && (sealed.lastProviderText || sealed.lastSentText)) {
            const publishedContent = sealed.lastProviderText ?? sealed.lastSentText;
            // The existing preview remains visible if its lossless boundary edit fails.
            trackPublishedAssistantPart({
              messageId: sealed.postId,
              content: publishedContent,
            });
            publishedAssistantOffset =
              consumeMattermostPublishedChunk({
                source: assistantText,
                offset: 0,
                chunk: publishedContent,
              }) ?? 0;
          }
          let providerFirstChunk = sealed.lastProviderText ?? firstChunk;
          if (firstChunk !== sealed.lastSentText) {
            const updated = await updateMattermostPost(params.client, sealed.postId, {
              message: firstChunk,
            });
            providerFirstChunk = updated.message ?? firstChunk;
          }
          if (assistantText) {
            trackPublishedAssistantPart({
              messageId: sealed.postId,
              content: providerFirstChunk,
            });
            publishedAssistantOffset =
              consumeMattermostPublishedChunk({
                source: assistantText,
                offset: 0,
                chunk: providerFirstChunk,
              }) ?? 0;
          }
        } else {
          const firstPost = await createMattermostPost(params.client, {
            channelId: params.channelId,
            message: firstChunk,
            rootId: params.rootId,
          });
          if (assistantText) {
            const publishedContent = firstPost.message ?? firstChunk;
            trackPublishedAssistantPart({
              messageId: firstPost.id,
              content: publishedContent,
            });
            publishedAssistantOffset =
              consumeMattermostPublishedChunk({
                source: assistantText,
                offset: 0,
                chunk: publishedContent,
              }) ?? 0;
          }
        }
        for (const chunk of chunks.slice(1)) {
          const post = await createMattermostPost(params.client, {
            channelId: params.channelId,
            message: chunk,
            rootId: params.rootId,
          });
          if (assistantText) {
            const publishedContent = post.message ?? chunk;
            trackPublishedAssistantPart({ messageId: post.id, content: publishedContent });
            publishedAssistantOffset =
              consumeMattermostPublishedChunk({
                source: assistantText,
                offset: publishedAssistantOffset,
                chunk: publishedContent,
              }) ?? publishedAssistantOffset;
          }
        }
        if (assistantText) {
          sealedAssistantTexts.push({ text: assistantText, requiresBlockBoundary: true });
        }
      } catch (err) {
        const acceptedDeliveryError = isChannelPartialDeliveryError(err)
          ? toErrorObject(err, "Mattermost accepted delivery failed")
          : undefined;
        if (acceptedDeliveryError) {
          // Publish terminal state before warning hooks can re-enter update or forceNewMessage.
          streamState.stopped = true;
          terminalAcceptedDeliveryError = acceptedDeliveryError;
        }
        const publishedAssistantPrefix = assistantText?.slice(0, publishedAssistantOffset).trim();
        if (publishedAssistantPrefix) {
          // A later physical chunk failed after this exact source prefix became durable.
          // Strip only that proven prefix; unlike a completed block, its suffix is inline.
          sealedAssistantTexts.push({
            text: publishedAssistantPrefix,
            requiresBlockBoundary: false,
          });
        }
        params.warn?.(
          `mattermost stream preview boundary flush failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (acceptedDeliveryError) {
          throw acceptedDeliveryError;
        }
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
    assertNoAcceptedDeliveryFailure();
    await loop.flush();
    await currentGeneration.ready;
    assertNoAcceptedDeliveryFailure();
  };
  const discardPending = async () => {
    assertNoAcceptedDeliveryFailure();
    await stopForClear();
    await currentGeneration.ready;
    assertNoAcceptedDeliveryFailure();
  };
  const clear = async () => {
    assertNoAcceptedDeliveryFailure();
    await clearWithStop(discardPending);
    assertNoAcceptedDeliveryFailure();
  };
  const deleteCurrentMessage = async () => {
    assertNoAcceptedDeliveryFailure();
    await clearWithStop(async () => {
      // Retraction drains this preview but keeps the turn open for its replacement.
      loop.resetPending();
      await loop.waitForInFlight();
      await currentGeneration.ready;
      assertNoAcceptedDeliveryFailure();
      currentGeneration.lastSentText = "";
      currentGeneration.latestSourceText = "";
      currentGeneration.latestAssistantText = undefined;
      loop.resetThrottleWindow();
    });
    assertNoAcceptedDeliveryFailure();
  };
  const seal = async () => {
    assertNoAcceptedDeliveryFailure();
    await sealLifecycle();
    await currentGeneration.ready;
    assertNoAcceptedDeliveryFailure();
  };
  const stop = async () => {
    assertNoAcceptedDeliveryFailure();
    await stopLifecycle();
    await currentGeneration.ready;
    assertNoAcceptedDeliveryFailure();
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
    assertNoAcceptedDeliveryFailure();
    await currentGeneration.ready;
    assertNoAcceptedDeliveryFailure();
  };
  const resolveFinalText = (text: string) => {
    const publishedParts = [...publishedAssistantParts.values()];
    if (sealedAssistantTexts.length === 0) {
      return { kind: "full" as const, text, publishedParts };
    }

    let remainingText = text.trim();
    for (const sealedText of sealedAssistantTexts) {
      const completed = sealedText.text.trim();
      if (!completed || !remainingText.startsWith(completed)) {
        return { kind: "full" as const, text, publishedParts };
      }
      const suffix = remainingText.slice(completed.length);
      // Canonical assistant block aggregation uses newline separators. A plain-space
      // suffix can be a block-local final that merely shares the prior block's prefix.
      if (sealedText.requiresBlockBoundary && suffix && !/^\r?\n/.test(suffix)) {
        return { kind: "full" as const, text, publishedParts };
      }
      remainingText = suffix.replace(sealedText.requiresBlockBoundary ? /^(?:\r?\n)+/ : /^\s+/, "");
    }
    const currentText = currentGeneration.latestAssistantText?.trim() ?? "";
    const remaining = remainingText.trim();
    if (currentText && !remaining.startsWith(currentText)) {
      return { kind: "full" as const, text, publishedParts };
    }
    return remaining
      ? { kind: "remaining" as const, text: remaining, publishedParts }
      : { kind: "already-delivered" as const, publishedParts };
  };

  params.log?.(`mattermost stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    updateAssistantText,
    flush,
    postId: () => currentGeneration.postId,
    clear,
    deleteCurrentMessage,
    discardPending,
    seal,
    stop,
    forceNewMessage,
    settleBoundaries,
    resolveFinalText,
  };
}
