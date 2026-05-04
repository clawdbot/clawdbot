/**
 * Teams streaming message using the streaminfo entity protocol.
 *
 * Follows the official Teams SDK pattern:
 * 1. First chunk → POST a typing activity with streaminfo entity (streamType: "streaming")
 * 2. Subsequent chunks → POST typing activities with streaminfo + incrementing streamSequence
 * 3. Finalize → POST a message activity with streaminfo (streamType: "final")
 *
 * Uses the shared draft-stream-loop for throttling (avoids rate limits).
 */

import { createDraftStreamLoop, type DraftStreamLoop } from "openclaw/plugin-sdk/channel-lifecycle";
import { readStringValue } from "openclaw/plugin-sdk/text-runtime";

/** Default throttle interval between stream updates (ms).
 * Teams docs recommend buffering tokens for 1.5-2s; limit is 1 req/s. */
const DEFAULT_THROTTLE_MS = 1500;

/** Minimum chars before sending the first streaming message. */
const MIN_INITIAL_CHARS = 20;

/** Teams message text limit. */
const TEAMS_MAX_CHARS = 4000;

/**
 * Stop streaming before Teams expires the content stream server-side.
 * The exact service limit is opaque, so stay comfortably under it.
 */
const MAX_STREAM_AGE_MS = 45_000;

type StreamSendFn = (activity: Record<string, unknown>) => Promise<unknown>;

type TeamsStreamOptions = {
  /** Function to send an activity (POST to Bot Framework). */
  sendActivity: StreamSendFn;
  /** Whether to enable feedback loop on the final message. */
  feedbackLoopEnabled?: boolean;
  /** Throttle interval in ms. Default: 600. */
  throttleMs?: number;
  /** Called on errors during streaming. */
  onError?: (err: unknown) => void;
};

import { AI_GENERATED_ENTITY } from "./ai-entity.js";
import { formatUnknownError } from "./errors.js";

function extractId(response: unknown): string | undefined {
  if (response && typeof response === "object" && "id" in response) {
    return readStringValue((response as { id?: unknown }).id);
  }
  return undefined;
}

function buildStreamInfoEntity(
  streamId: string | undefined,
  streamType: "informative" | "streaming" | "final",
  streamSequence?: number,
): Record<string, unknown> {
  const entity: Record<string, unknown> = {
    type: "streaminfo",
    streamType,
  };
  // streamId is only present after the first chunk (returned by the service)
  if (streamId) {
    entity.streamId = streamId;
  }
  // streamSequence must be present for start/continue, but NOT for final
  if (streamSequence != null) {
    entity.streamSequence = streamSequence;
  }
  return entity;
}

export class TeamsHttpStream {
  private sendActivity: StreamSendFn;
  private feedbackLoopEnabled: boolean;
  private onError?: (err: unknown) => void;

  private accumulatedText = "";
  private streamId: string | undefined = undefined;
  private sequenceNumber = 0;
  private stopped = false;
  private finalized = false;
  private streamFailed = false;
  private lastStreamedText = "";
  private streamStartedAt: number | undefined = undefined;
  private loop: DraftStreamLoop;

  constructor(options: TeamsStreamOptions) {
    this.sendActivity = options.sendActivity;
    this.feedbackLoopEnabled = options.feedbackLoopEnabled ?? false;
    this.onError = options.onError;

    this.loop = createDraftStreamLoop({
      throttleMs: options.throttleMs ?? DEFAULT_THROTTLE_MS,
      isStopped: () => this.stopped,
      sendOrEditStreamMessage: (text) => this.pushStreamChunk(text),
    });
  }

  /**
   * Send an informative status update (blue progress bar in Teams).
   * Call this immediately when a message is received, before LLM starts generating.
   * Establishes the stream so subsequent chunks continue from this stream ID.
   */
  async sendInformativeUpdate(text: string): Promise<void> {
    if (this.stopped || this.finalized) {
      return;
    }

    this.sequenceNumber++;

    const activity: Record<string, unknown> = {
      type: "typing",
      text,
      entities: [buildStreamInfoEntity(this.streamId, "informative", this.sequenceNumber)],
    };

    try {
      const response = await this.sendActivity(activity);
      if (!this.streamId) {
        this.streamId = extractId(response);
      }
    } catch (err) {
      this.onError?.(err);
    }
  }

  /**
   * Ingest partial text from the LLM token stream.
   * Called by onPartialReply — accumulates text and throttles updates.
   */
  update(text: string): void {
    if (this.stopped || this.finalized) {
      return;
    }
    this.accumulatedText = text;

    // Wait for minimum chars before first send (avoids push notification flicker)
    if (!this.streamId && this.accumulatedText.length < MIN_INITIAL_CHARS) {
      return;
    }

    // Text exceeded Teams limit — finalize immediately with what we have
    // so the user isn't left waiting while the LLM keeps generating.
    if (this.accumulatedText.length > TEAMS_MAX_CHARS) {
      this.streamFailed = true;
      void this.finalize();
      return;
    }

    // Stop early before Teams expires the stream server-side. finalize() will
    // close the stream with the last good content, and reply-stream-controller
    // will deliver any remaining suffix via normal fallback delivery.
    if (this.streamStartedAt && Date.now() - this.streamStartedAt >= MAX_STREAM_AGE_MS) {
      this.streamFailed = true;
      void this.finalize();
      return;
    }

    // Don't append cursor — Teams requires each chunk to be a prefix of subsequent chunks.
    // The cursor character would cause "content should contain previously streamed content" errors.
    this.loop.update(this.accumulatedText);
  }

  /**
   * Replace an informative progress update with final answer text.
   * Returns false when the stream could not safely carry the final text, so
   * callers can deliver the answer through the normal Teams message path.
   */
  async replaceInformativeWithFinal(text: string): Promise<boolean> {
    if (this.stopped || this.finalized) {
      return false;
    }
    this.update(text);
    await this.loop.flush();
    await this.finalize();
    return !this.streamFailed && this.hasContent;
  }

  /**
   * Finalize the stream — send the final message activity.
   */
  async finalize(): Promise<void> {
    if (this.finalized) {
      return;
    }
    this.finalized = true;
    this.stopped = true;
    this.loop.stop();
    await this.loop.waitForInFlight();

    // If no text was streamed (e.g. agent sent a card via tool instead of
    // streaming text), just return. Teams auto-clears the informative progress
    // bar after its streaming timeout. Sending an empty final message fails
    // with 403.
    if (!this.accumulatedText.trim()) {
      return;
    }

    // If streaming failed (>4000 chars or POST errors), close the stream
    // with the last successfully streamed text so Teams removes the "Stop"
    // button and replaces the partial chunks. deliver() handles the complete
    // response since hasContent returns false when streamFailed is true.
    if (this.streamFailed) {
      if (this.streamId) {
        try {
          await this.sendActivity({
            type: "message",
            text: this.lastStreamedText || "",
            channelData: { feedbackLoopEnabled: this.feedbackLoopEnabled },
            entities: [AI_GENERATED_ENTITY, buildStreamInfoEntity(this.streamId, "final")],
          });
        } catch {
          // Best effort — stream will auto-close after Teams timeout
        }
      }
      return;
    }

    // Send final message activity.
    // Per the spec: type=message, streamType=final, NO streamSequence.
    try {
      const entities: Array<Record<string, unknown>> = [AI_GENERATED_ENTITY];
      if (this.streamId) {
        entities.push(buildStreamInfoEntity(this.streamId, "final"));
      }

      const finalActivity: Record<string, unknown> = {
        type: "message",
        text: this.accumulatedText,
        channelData: {
          feedbackLoopEnabled: this.feedbackLoopEnabled,
        },
        entities,
      };

      await this.sendActivity(finalActivity);
    } catch (err) {
      this.streamFailed = true;
      this.onError?.(err);
    }
  }

  /** Whether streaming successfully delivered content (at least one chunk sent, not failed). */
  get hasContent(): boolean {
    return this.accumulatedText.length > 0 && !this.streamFailed;
  }

  /** Whether streaming failed and fallback delivery is needed. */
  get isFailed(): boolean {
    return this.streamFailed;
  }

  /** Number of characters successfully streamed before failure. */
  get streamedLength(): number {
    return this.lastStreamedText.length;
  }

  /** Whether the stream has been finalized. */
  get isFinalized(): boolean {
    return this.finalized;
  }

  /** Whether streaming fell back (not used in this implementation). */
  get isFallback(): boolean {
    return false;
  }

  /**
   * Send a single streaming chunk as a typing activity with streaminfo.
   * Per the Teams REST API spec:
   * - First chunk: no streamId, streamSequence=1 → returns 201 with { id: streamId }
   * - Subsequent chunks: include streamId, increment streamSequence → returns 202
   */
  private async pushStreamChunk(text: string): Promise<boolean> {
    if (this.stopped && !this.finalized) {
      return false;
    }

    this.sequenceNumber++;

    const activity: Record<string, unknown> = {
      type: "typing",
      text,
      entities: [buildStreamInfoEntity(this.streamId, "streaming", this.sequenceNumber)],
    };

    try {
      const response = await this.sendActivity(activity);
      if (!this.streamStartedAt) {
        this.streamStartedAt = Date.now();
      }
      if (!this.streamId) {
        this.streamId = extractId(response);
      }
      this.lastStreamedText = text;
      return true;
    } catch (err) {
      const axiosData = (err as { response?: { data?: unknown; status?: number } })?.response;
      const statusCode = axiosData?.status ?? (err as { statusCode?: number })?.statusCode;
      const responseBody = axiosData?.data ? JSON.stringify(axiosData.data).slice(0, 300) : "";
      const msg = formatUnknownError(err);
      this.onError?.(
        new Error(
          `stream POST failed (HTTP ${statusCode ?? "?"}): ${msg}${responseBody ? ` body=${responseBody}` : ""}`,
        ),
      );
      this.streamFailed = true;
      return false;
    }
  }
}
