import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import type { ReplyPayload } from "../runtime-api.js";
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

const INFORMATIVE_STATUS_TEXTS = [
  "Thinking...",
  "Working on that...",
  "Checking the details...",
  "Putting an answer together...",
];

export function pickInformativeStatusText(random = Math.random): string {
  const index = Math.floor(random() * INFORMATIVE_STATUS_TEXTS.length);
  return INFORMATIVE_STATUS_TEXTS[index] ?? INFORMATIVE_STATUS_TEXTS[0];
}

export function createTeamsReplyStreamController(params: {
  conversationType?: string;
  context: MSTeamsTurnContext;
  feedbackLoopEnabled: boolean;
  log: MSTeamsMonitorLogger;
  random?: () => number;
}) {
  const isPersonal = normalizeOptionalLowercaseString(params.conversationType) === "personal";
  const stream = isPersonal
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
  let pendingFinalize: Promise<void> | undefined;

  return {
    async onReplyStart(): Promise<void> {
      if (!stream || informativeUpdateSent) {
        return;
      }
      informativeUpdateSent = true;
      await stream.sendInformativeUpdate(pickInformativeStatusText(params.random));
    },

    onPartialReply(payload: { text?: string }): void {
      if (!stream || !payload.text) {
        return;
      }
      streamReceivedTokens = true;
      stream.update(payload.text);
    },

    preparePayload(payload: ReplyPayload): Maybe<ReplyPayload> {
      if (!stream || !streamReceivedTokens) {
        return payload;
      }

      const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);

      // Stream failed after partial delivery (e.g. > 4000 chars). Send only
      // the unstreamed suffix via block delivery to avoid duplicate text.
      if (stream.isFailed) {
        streamReceivedTokens = false;

        if (!payload.text) {
          return payload;
        }

        const streamedLength = stream.streamedLength;
        if (streamedLength <= 0) {
          return payload;
        }

        const remainingText = payload.text.slice(streamedLength);
        if (!remainingText) {
          return hasMedia ? { ...payload, text: undefined } : undefined;
        }

        return { ...payload, text: remainingText };
      }

      if (!stream.hasContent || stream.isFinalized) {
        return payload;
      }

      // Stream handled this text segment. Finalize it and reset so any
      // subsequent text segments (after tool calls) use fallback delivery.
      // finalize() is idempotent; the later call in markDispatchIdle is a no-op.
      streamReceivedTokens = false;
      pendingFinalize = stream.finalize();

      if (!hasMedia) {
        return undefined;
      }
      return { ...payload, text: undefined };
    },

    async finalize(): Promise<void> {
      await pendingFinalize;
      await stream?.finalize();
    },

    hasStream(): boolean {
      return Boolean(stream);
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
