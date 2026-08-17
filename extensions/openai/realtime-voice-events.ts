import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";
import type { RealtimeVoiceSessionConnection } from "openclaw/plugin-sdk/realtime-voice";
import { normalizeRealtimeVoiceResponseOutcome } from "openclaw/plugin-sdk/realtime-voice";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readRealtimeErrorDetail } from "./realtime-provider-shared.js";
import { OpenAIRealtimeProtocol } from "./realtime-voice-protocol.js";
import {
  OPENAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX,
  OPENAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR,
  isOpenAIRealtimeMaxSessionDurationError,
  readRealtimeErrorEventId,
  type RealtimeEvent,
} from "./realtime-voice-session-policy.js";

export class OpenAIRealtimeMalformedAudioError extends Error {}

function base64ToBuffer(b64: string): Buffer {
  const canonicalAudio = canonicalizeBase64(b64);
  if (!canonicalAudio) {
    throw new OpenAIRealtimeMalformedAudioError(
      "OpenAI realtime stream returned malformed base64 audio data",
    );
  }
  return Buffer.from(canonicalAudio, "base64");
}

export abstract class OpenAIRealtimeEvents extends OpenAIRealtimeProtocol {
  protected handleEvent(event: RealtimeEvent, connection: RealtimeVoiceSessionConnection): void {
    const emitServerEvent = () =>
      this.config.onEvent?.({
        direction: "server",
        type: event.type,
        detail: this.describeServerEvent(event),
        ...(event.item_id ? { itemId: event.item_id } : {}),
        ...((event.response_id ?? event.response?.id)
          ? { responseId: event.response_id ?? event.response?.id }
          : {}),
      });
    if (
      event.type === "error" &&
      isOpenAIRealtimeMaxSessionDurationError(readRealtimeErrorDetail(event.error))
    ) {
      this.rotateExpiredSession();
      return;
    }
    if (event.type === "response.done") {
      this.handleResponseDone(event, connection, emitServerEvent);
      return;
    }
    if (event.type === "response.cancelled") {
      try {
        emitServerEvent();
      } finally {
        this.releaseResponseState();
      }
      return;
    }
    emitServerEvent();
    switch (event.type) {
      case "session.created":
        return;

      case "session.updated": {
        this.onSessionUpdated(connection);
        return;
      }

      case "response.created":
        this.responseActive = true;
        this.responseCreateInFlight = false;
        return;

      case "conversation.output_audio.delta":
      case "response.audio.delta":
      case "response.output_audio.delta": {
        const audioDelta = event.delta ?? event.data;
        if (!audioDelta) {
          return;
        }
        // Stale tail of an item we already truncated: the truncate request
        // and the provider's in-flight generation can race, so more deltas
        // for that exact item_id can still arrive after we told the server
        // (and the client) to stop at audioEndMs. Re-adopting it here as if
        // it were a new item would restart clock/byte accounting mid-item
        // and could produce a second truncate whose audio_end_ms looks
        // small and plausible but is actually counted from the truncation
        // point rather than the item's real start.
        if (event.item_id && event.item_id === this.lastTruncatedItemId) {
          return;
        }
        const audio = base64ToBuffer(audioDelta);
        this.config.onAudio(audio);
        if (event.item_id && event.item_id !== this.lastAssistantItemId) {
          this.lastAssistantItemId = event.item_id;
          this.responseStartTimestamp = this.latestMediaTimestamp;
          // New item: byte accounting from the previous item no longer applies.
          this.resetItemAudioAccounting();
        } else if (this.responseStartTimestamp === null) {
          this.responseStartTimestamp = this.latestMediaTimestamp;
        }
        // item_id is optional on the wire type. Only count bytes toward a
        // known item's duration - crediting an unidentified delta to
        // whichever item happened to be current would let audio_end_ms
        // exceed that item's real length again (the class of bug this
        // accounting exists to prevent), whereas skipping the count merely
        // makes truncate slightly more conservative.
        if (event.item_id) {
          this.deliveredAudioBytesForCurrentItem += audio.byteLength;
        }
        this.responseActive = true;
        this.sendMark();
        return;
      }

      case "input_audio_buffer.speech_started":
        if (this.config.interruptResponseOnInputAudio ?? this.config.autoRespondToAudio ?? true) {
          this.handleBargeIn();
        }
        return;

      case "conversation.output_transcript.delta":
      case "response.text.delta":
      case "response.output_text.delta":
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        if (event.delta) {
          this.config.onTranscript?.("assistant", event.delta, false);
        }
        return;

      case "response.text.done":
      case "response.output_text.done":
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done":
        {
          const transcript = event.transcript ?? event.text;
          if (transcript) {
            this.config.onTranscript?.("assistant", transcript, true);
          }
        }
        return;

      case "conversation.input_transcript.delta":
      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.config.onTranscript?.("user", event.delta, false);
        }
        return;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.config.onTranscript?.("user", event.transcript, true);
        }
        return;

      case "conversation.item.input_audio_transcription.failed":
        this.config.onError?.(new Error(readRealtimeErrorDetail(event.error)));
        break;

      case "conversation.item.added":
        break;

      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done":
      case "conversation.item.done":
        // These events are provisional and can also arrive for interrupted,
        // incomplete, or cancelled responses. Successful response.done output
        // is the sole execution boundary.
        return;

      case "error": {
        const detail = readRealtimeErrorDetail(event.error);
        const rejectedEventId = readRealtimeErrorEventId(event.error);
        if (rejectedEventId && rejectedEventId === this.manualTruncateEventId) {
          // A rejected conversation.item.truncate (e.g. "Audio content of
          // Xms is already shorter than Yms") previously fell through to
          // the generic onError branch below with no state repair. By that
          // point handleBargeIn had already optimistically cleared
          // lastAssistantItemId/responseStartTimestamp/marks, so there was
          // nothing left to retry - but responseCancelInFlight, if this
          // barge-in also sent response.cancel, is cleared ONLY by a
          // response.cancelled event or a rejection whose detail exactly
          // matches OPENAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR. A
          // truncate rejection matches neither, so responseCancelInFlight
          // could be left permanently true, which makes every future
          // requestResponseCreate() queue as "pending" forever and the
          // conversation never produces another assistant turn. Release it
          // here so a truncate rejection can never strand the session.
          this.manualTruncateEventId = null;
          this.config.onError?.(new Error(detail));
          if (this.responseCancelInFlight) {
            this.responseCancelInFlight = false;
            this.manualResponseCancelEventId = null;
            if (this.responseCreatePending) {
              this.flushPendingResponseCreate();
            } else {
              this.restoreAutoRespondAfterManualResponse();
            }
          }
          return;
        }
        if (rejectedEventId && rejectedEventId === this.standaloneSpeechEventId) {
          this.responseCreateInFlight = false;
          this.standaloneSpeechActive = false;
          this.standaloneSpeechEventId = null;
          this.config.onError?.(new Error(detail));
          if (this.standaloneSpeechQueue.length > 0) {
            this.flushStandaloneSpeech();
          } else if (this.responseCreatePending) {
            this.flushPendingResponseCreate();
          }
          return;
        }
        const rejectsManualResponseCreate =
          this.manualResponseCreateEventId !== null &&
          readRealtimeErrorEventId(event.error) === this.manualResponseCreateEventId;
        if (
          rejectsManualResponseCreate &&
          detail.startsWith(OPENAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX)
        ) {
          this.responseActive = true;
          this.responseCreateInFlight = false;
          this.manualResponseCreateEventId = null;
          this.responseCreatePending = true;
          return;
        }
        const rejectsManualResponseCancel =
          this.manualResponseCancelEventId !== null &&
          readRealtimeErrorEventId(event.error) === this.manualResponseCancelEventId;
        if (detail === OPENAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR) {
          if (!rejectsManualResponseCancel) {
            return;
          }
          this.responseActive = false;
          this.responseCancelInFlight = false;
          this.manualResponseCancelEventId = null;
          if (this.responseCreatePending) {
            this.flushPendingResponseCreate();
          } else {
            this.restoreAutoRespondAfterManualResponse();
          }
          return;
        }
        if (rejectsManualResponseCreate) {
          this.responseCreateInFlight = false;
          this.manualResponseCreateEventId = null;
          if (this.responseCreatePending) {
            this.flushPendingResponseCreate();
          } else {
            this.restoreAutoRespondAfterManualResponse();
          }
        }
        this.config.onError?.(new Error(detail));
      }

      default:
    }
  }

  private handleCompletedResponse(
    event: RealtimeEvent,
    connection: RealtimeVoiceSessionConnection,
  ): boolean {
    if (
      event.response?.status !== "completed" ||
      !Array.isArray(event.response.output) ||
      !this.config.onToolCall
    ) {
      return false;
    }
    for (const output of event.response.output) {
      if (!this.acceptsEvent(connection) || !this.isTransportOpen()) {
        return true;
      }
      if (
        !isRecord(output) ||
        output.type !== "function_call" ||
        (output.status !== undefined && output.status !== "completed")
      ) {
        continue;
      }
      const itemId = typeof output.id === "string" ? output.id.trim() || undefined : undefined;
      const callId = typeof output.call_id === "string" ? output.call_id.trim() : "";
      const name = typeof output.name === "string" ? output.name.trim() : "";
      if (!callId || !name || this.completedToolCallIds.has(callId)) {
        continue;
      }
      if (this.completedToolCallIds.size >= OpenAIRealtimeProtocol.MAX_COMPLETED_TOOL_CALL_IDS) {
        this.failToolCallSessionLimit(
          new Error(
            `OpenAI realtime tool-call session limit exceeded (${OpenAIRealtimeProtocol.MAX_COMPLETED_TOOL_CALL_IDS})`,
          ),
          connection,
        );
        return true;
      }
      this.completedToolCallIds.add(callId);
      this.pendingToolCallIds.add(callId);
      if (typeof output.arguments !== "string") {
        this.rejectToolCallArguments({
          itemId,
          callId,
          reason: "invalid-json-type",
          message: "Invalid tool arguments: expected a JSON object.",
        });
        continue;
      }
      const rawArgs = output.arguments;
      if (Buffer.byteLength(rawArgs, "utf8") > OpenAIRealtimeProtocol.MAX_TOOL_ARGUMENT_BYTES) {
        this.rejectToolCallArguments({
          itemId,
          callId,
          reason: "too-large",
          message: `Realtime tool arguments exceed the ${OpenAIRealtimeProtocol.MAX_TOOL_ARGUMENT_BYTES}-byte UTF-8 limit`,
        });
        continue;
      }
      let args: unknown;
      try {
        args = JSON.parse(rawArgs || "{}");
      } catch {
        this.rejectToolCallArguments({
          itemId,
          callId,
          reason: "malformed-json",
          message: "Invalid tool arguments: expected a JSON object.",
        });
        continue;
      }
      if (!isRecord(args)) {
        this.rejectToolCallArguments({
          itemId,
          callId,
          reason: "non-object-json",
          message: "Invalid tool arguments: expected a JSON object.",
        });
        continue;
      }
      this.config.onToolCall({ itemId: itemId ?? callId, callId, name, args });
    }
    return false;
  }

  private handleResponseDone(
    event: RealtimeEvent,
    connection: RealtimeVoiceSessionConnection,
    emitServerEvent: () => void,
  ): void {
    const outcome = normalizeRealtimeVoiceResponseOutcome({
      providerLabel: "OpenAI realtime voice",
      response: event.response,
      responseId: event.response_id,
    });
    let callbackError: unknown;
    let providerTerminated = false;
    const invoke = (callback: () => void) => {
      try {
        callback();
      } catch (error) {
        callbackError ??= error;
      }
    };
    try {
      invoke(() => this.config.onResponseDone?.(outcome));
      invoke(emitServerEvent);
      invoke(() => {
        providerTerminated = this.handleCompletedResponse(event, connection);
      });
    } finally {
      // response.done owns response state regardless of observer success. A fatal tool
      // boundary still clears state, but must not start queued work on a closing socket.
      const canDrain =
        !providerTerminated && this.acceptsEvent(connection) && this.isTransportOpen();
      this.releaseResponseState({ drain: canDrain });
    }
    if (callbackError) {
      throw callbackError instanceof Error
        ? callbackError
        : new Error("OpenAI realtime response callback failed", { cause: callbackError });
    }
  }

  private rejectToolCallArguments(params: {
    itemId?: string;
    callId: string;
    reason: string;
    message: string;
  }): void {
    this.config.onEvent?.({
      direction: "server",
      type: "tool_call.arguments.rejected",
      detail: `reason=${params.reason}`,
      itemId: params.itemId,
    });
    this.submitToolResult(params.callId, { error: params.message });
  }

  private describeServerEvent(event: RealtimeEvent): string | undefined {
    if (
      event.type === "error" ||
      event.type === "conversation.item.input_audio_transcription.failed"
    ) {
      return readRealtimeErrorDetail(event.error);
    }
    if (event.type === "session.created" || event.type === "session.updated") {
      const session = isRecord(event.session) ? event.session : undefined;
      const tools = Array.isArray(session?.tools) ? session.tools.length : 0;
      const rawToolChoice = session?.tool_choice;
      const toolChoice =
        typeof rawToolChoice === "string"
          ? rawToolChoice
          : isRecord(rawToolChoice) && typeof rawToolChoice.type === "string"
            ? rawToolChoice.type
            : "unset";
      return `tools=${tools} toolChoice=${toolChoice}`;
    }
    if (
      (event.type === "conversation.item.added" || event.type === "conversation.item.done") &&
      event.item?.type
    ) {
      return [
        `itemType=${event.item.type}`,
        event.item.name ? `name=${event.item.name}` : undefined,
      ]
        .filter(Boolean)
        .join(" ");
    }
    if (event.type === "response.done") {
      const status = event.response?.status;
      const details =
        event.response?.status_details === undefined
          ? undefined
          : JSON.stringify(event.response.status_details);
      return (
        [status ? `status=${status}` : undefined, details].filter(Boolean).join(" ") || undefined
      );
    }
    if (event.type === "response.cancelled") {
      return "cancelled";
    }
    return undefined;
  }

  protected abstract acceptsEvent(connection: RealtimeVoiceSessionConnection): boolean;
  protected abstract isTransportOpen(): boolean;
  protected abstract onSessionUpdated(connection: RealtimeVoiceSessionConnection): void;
  protected abstract rotateExpiredSession(): void;
  protected abstract failToolCallSessionLimit(
    error: Error,
    connection: RealtimeVoiceSessionConnection,
  ): void;
}
