import {
  createLiveMessageState,
  createPreviewMessageReceipt,
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
  markLiveMessageFinalized,
  type LiveMessageState,
} from "openclaw/plugin-sdk/channel-message";
import {
  createChannelProgressDraftGate,
  type ChannelProgressDraftLine,
  formatChannelProgressDraftText,
  isChannelProgressDraftWorkToolName,
  resolveChannelPreviewStreamMode,
  resolveChannelProgressDraftMaxLines,
  resolveChannelProgressDraftLabel,
  resolveChannelStreamingPreviewToolProgress,
} from "openclaw/plugin-sdk/channel-streaming";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MSTeamsConfig, ReplyPayload } from "../runtime-api.js";
import { formatUnknownError } from "./errors.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import { TeamsHttpStream } from "./streaming-message.js";

// Local generic wrapper to defer union resolution. Works around a
// single-file-mode limitation in the type-aware lint where imported
// types resolved via extension runtime-api barrels are treated as
// `error` (acting as `any`) and trip `no-redundant-type-constituents`
// when combined with `undefined` in a union.
type Maybe<T> = T | undefined;

export function pickInformativeStatusText(
  params: { config?: MSTeamsConfig; seed?: string; random?: () => number } | (() => number) = {},
): string | undefined {
  const options = typeof params === "function" ? { random: params } : params;
  return resolveChannelProgressDraftLabel({
    entry: options.config,
    seed: options.seed,
    random: options.random,
  });
}

export function createTeamsReplyStreamController(params: {
  conversationType?: string;
  context: MSTeamsTurnContext;
  feedbackLoopEnabled: boolean;
  log: MSTeamsMonitorLogger;
  msteamsConfig?: MSTeamsConfig;
  progressSeed?: string;
  random?: () => number;
}) {
  const isPersonal = normalizeOptionalLowercaseString(params.conversationType) === "personal";
  const streamMode = resolveChannelPreviewStreamMode(params.msteamsConfig, "partial");
  const shouldUseNativeStream =
    isPersonal && (streamMode === "partial" || streamMode === "progress");
  const shouldSuppressDefaultToolProgressMessages =
    shouldUseNativeStream && streamMode === "progress";
  const shouldStreamPreviewToolProgress =
    shouldSuppressDefaultToolProgressMessages &&
    resolveChannelStreamingPreviewToolProgress(params.msteamsConfig);
  const stream = shouldUseNativeStream
    ? new TeamsHttpStream({
        sendActivity: (activity) => params.context.sendActivity(activity),
        feedbackLoopEnabled: params.feedbackLoopEnabled,
        onError: (err) => {
          params.log.debug?.(`stream error: ${formatUnknownError(err)}`);
        },
      })
    : undefined;

  let streamReceivedTokens = false;
  let informativeUpdateSent = false;
  let progressLines: Array<string | ChannelProgressDraftLine> = [];
  let lastInformativeText = "";
  let pendingFinalize: Promise<void> | undefined;
  let liveState: LiveMessageState<ReplyPayload> = createLiveMessageState({
    canFinalizeInPlace: Boolean(stream),
  });

  const markStreamFinalized = () => {
    if (!stream || stream.isFailed) {
      return;
    }
    const messageId = stream.messageId ?? stream.previewStreamId;
    if (!messageId) {
      return;
    }
    liveState = markLiveMessageFinalized(liveState, createPreviewMessageReceipt({ id: messageId }));
  };

  const renderInformativeUpdate = async () => {
    if (!stream) {
      return;
    }
    const informativeText = formatChannelProgressDraftText({
      entry: params.msteamsConfig,
      lines: shouldStreamPreviewToolProgress ? progressLines : [],
      seed: params.progressSeed,
      bullet: "-",
    });
    if (!informativeText || informativeText === lastInformativeText) {
      return;
    }
    lastInformativeText = informativeText;
    informativeUpdateSent = true;
    await stream.sendInformativeUpdate(informativeText);
  };

  const progressDraftGate = createChannelProgressDraftGate({
    onStart: renderInformativeUpdate,
  });

  const noteProgressWork = async (options?: { toolName?: string }): Promise<void> => {
    if (!stream || streamMode !== "progress") {
      return;
    }
    if (options?.toolName !== undefined && !isChannelProgressDraftWorkToolName(options.toolName)) {
      return;
    }
    const hadStarted = progressDraftGate.hasStarted;
    await progressDraftGate.noteWork();
    if (hadStarted && progressDraftGate.hasStarted) {
      await renderInformativeUpdate();
    }
  };

  const pushProgressLine = async (
    line?: string | ChannelProgressDraftLine,
    options?: { toolName?: string },
  ): Promise<void> => {
    if (!stream || streamMode !== "progress") {
      return;
    }
    if (options?.toolName !== undefined && !isChannelProgressDraftWorkToolName(options.toolName)) {
      return;
    }
    if (shouldStreamPreviewToolProgress) {
      const normalized = normalizeProgressLineIdentity(line);
      if (normalized) {
        const previous = normalizeProgressLineIdentity(progressLines.at(-1));
        if (previous !== normalized) {
          const progressLine: string | ChannelProgressDraftLine =
            typeof line === "object" && line !== undefined ? line : normalized;
          progressLines = [...progressLines, progressLine].slice(
            -resolveChannelProgressDraftMaxLines(params.msteamsConfig),
          );
        }
      }
    }
    await noteProgressWork();
  };

  const fallbackAfterStreamFailure = (
    payload: ReplyPayload,
    hasMedia: boolean,
  ): Maybe<ReplyPayload> => {
    if (!payload.text) {
      return payload;
    }
    const streamedLength = stream?.streamedLength ?? 0;
    if (streamedLength <= 0) {
      return payload;
    }
    const remainingText = payload.text.slice(streamedLength);
    if (!remainingText) {
      return hasMedia ? { ...payload, text: undefined } : undefined;
    }
    return { ...payload, text: remainingText };
  };

  const finalizeProgressPayload = async (
    payload: ReplyPayload,
    hasMedia: boolean,
  ): Promise<Maybe<ReplyPayload>> => {
    if (!stream || !payload.text) {
      return payload;
    }
    const result = await deliverWithFinalizableLivePreviewAdapter({
      kind: "final",
      payload,
      liveState,
      adapter: defineFinalizableLivePreviewAdapter<ReplyPayload, string, { text: string }>({
        draft: {
          flush: async () => {},
          clear: async () => {},
          id: () => stream.previewStreamId,
        },
        buildFinalEdit: (candidate) => (candidate.text ? { text: candidate.text } : undefined),
        editFinal: async (_previewId, edit) => {
          const finalized = await stream.replaceInformativeWithFinal(edit.text);
          informativeUpdateSent = false;
          if (!finalized || stream.isFailed) {
            throw new Error("Teams progress stream finalization failed");
          }
        },
        resolveFinalizedId: (previewId) => stream.messageId ?? stream.previewStreamId ?? previewId,
        createPreviewReceipt: (id) => createPreviewMessageReceipt({ id }),
        onPreviewFinalized: (_id, _receipt, state) => {
          liveState = state;
        },
        logPreviewEditFailure: (err) => {
          params.log.debug?.(`stream finalization failed: ${formatUnknownError(err)}`);
        },
      }),
      deliverNormally: async () => false,
    });

    return result.kind === "preview-finalized"
      ? hasMedia
        ? { ...payload, text: undefined }
        : undefined
      : payload;
  };

  return {
    async onReplyStart(): Promise<void> {
      return;
    },

    async noteProgressWork(options?: { toolName?: string }): Promise<void> {
      await noteProgressWork(options);
    },

    onPartialReply(payload: { text?: string }): void {
      if (!stream || !payload.text) {
        return;
      }
      if (streamMode === "progress") {
        return;
      }
      streamReceivedTokens = true;
      stream.update(payload.text);
    },

    async pushProgressLine(
      line?: string | ChannelProgressDraftLine,
      options?: { toolName?: string },
    ): Promise<void> {
      await pushProgressLine(line, options);
    },

    shouldSuppressDefaultToolProgressMessages(): boolean {
      return shouldSuppressDefaultToolProgressMessages;
    },

    shouldStreamPreviewToolProgress(): boolean {
      return shouldStreamPreviewToolProgress;
    },

    async preparePayload(payload: ReplyPayload): Promise<Maybe<ReplyPayload>> {
      const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);

      if (stream && streamMode === "progress" && informativeUpdateSent && !stream.isFinalized) {
        if (!payload.text) {
          return payload;
        }
        return await finalizeProgressPayload(payload, hasMedia);
      }

      if (!stream || !streamReceivedTokens) {
        return payload;
      }

      // Stream failed after partial delivery (e.g. > 4000 chars). Send only
      // the unstreamed suffix via block delivery to avoid duplicate text.
      if (stream.isFailed) {
        streamReceivedTokens = false;

        return fallbackAfterStreamFailure(payload, hasMedia);
      }

      if (!stream.hasContent || stream.isFinalized) {
        return payload;
      }

      // Stream handled this text segment. Finalize it and reset so any
      // subsequent text segments (after tool calls) use fallback delivery.
      // finalize() is idempotent; the later call in markDispatchIdle is a no-op.
      streamReceivedTokens = false;
      pendingFinalize = stream.finalize().then(() => {
        markStreamFinalized();
      });

      if (!hasMedia) {
        return undefined;
      }
      return { ...payload, text: undefined };
    },

    async finalize(): Promise<void> {
      progressDraftGate.cancel();
      await pendingFinalize;
      if (!pendingFinalize) {
        await stream?.finalize();
        markStreamFinalized();
      }
    },

    hasStream(): boolean {
      return Boolean(stream);
    },

    liveState(): LiveMessageState<ReplyPayload> {
      return liveState;
    },

    /**
     * Whether the Teams streaming card is currently receiving LLM tokens.
     * Used to gate side-channel keepalive activity so we don't overlay plain
     * "typing" indicators on top of a live streaming card.
     *
     * Returns true only while the stream is actively chunking text into the
     * streaming card. The informative update (blue progress bar) is short
     * lived so we intentionally do not count it as "active"; this way the
     * typing keepalive can still fire during the informative window and
     * during tool chains between text segments.
     *
     * Returns false when:
     * - No stream exists (non-personal conversation).
     * - Stream has not yet received any text tokens.
     * - Stream has been finalized (e.g. after the first text segment, while
     *   tools run before the next segment).
     */
    isStreamActive(): boolean {
      if (!stream) {
        return false;
      }
      if (stream.isFinalized || stream.isFailed) {
        return false;
      }
      return streamReceivedTokens;
    },
  };
}

function normalizeProgressLineIdentity(
  line: string | ChannelProgressDraftLine | undefined,
): string {
  const text = typeof line === "string" ? line : line?.text;
  return text?.replace(/\s+/g, " ").trim() ?? "";
}
