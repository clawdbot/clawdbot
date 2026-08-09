import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";
import type { RealtimeVoiceSessionConnection } from "openclaw/plugin-sdk/realtime-voice";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  XAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX,
  XAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR,
  readXaiRealtimeErrorDetail,
  type XaiRealtimeEvent,
} from "./realtime-voice-config.js";
import { XaiRealtimeVoiceProtocol } from "./realtime-voice-protocol.js";

export class XaiRealtimeMalformedAudioError extends Error {}

export abstract class XaiRealtimeVoiceEvents extends XaiRealtimeVoiceProtocol {
  private assistantTranscriptBuffer = "";
  private assistantTranscriptFinalized = false;
  private inputTranscriptReplacements = new Map<string, string>();

  protected abstract acceptsEvent(connection: RealtimeVoiceSessionConnection): boolean;
  protected abstract onSessionUpdated(connection: RealtimeVoiceSessionConnection): void;

  protected handleEvent(event: XaiRealtimeEvent, connection: RealtimeVoiceSessionConnection): void {
    this.config.onEvent?.({
      direction: "server",
      type: event.type,
      detail: this.describeServerEvent(event),
      ...(event.item_id ? { itemId: event.item_id } : {}),
      ...((event.response_id ?? event.response?.id)
        ? { responseId: event.response_id ?? event.response?.id }
        : {}),
    });
    if (!this.acceptsEvent(connection)) {
      return;
    }
    switch (event.type) {
      case "session.created":
        return;
      case "conversation.created": {
        const conversationId = normalizeOptionalString(event.conversation?.id);
        if (conversationId) {
          this.conversationId = conversationId;
        }
        return;
      }
      case "conversation.item.created":
      case "conversation.item.added": {
        const item = event.item;
        const callId = normalizeOptionalString(item?.call_id);
        if (item?.type === "function_call_output" && callId) {
          this.pendingToolResultAcks.delete(callId);
          return;
        }
        if (event.type === "conversation.item.created") {
          this.emitCompletedToolCall(item, event);
        }
        return;
      }
      case "session.updated":
        this.onSessionUpdated(connection);
        return;
      case "response.created":
        this.responseActive = true;
        this.responseCreateInFlight = false;
        this.markQueue = [];
        this.lastAssistantItemId = null;
        this.responseStartTimestamp = null;
        this.resetAssistantTranscript();
        return;
      case "response.output_audio.delta": {
        const audioDelta = event.delta ?? event.data;
        if (!audioDelta) {
          return;
        }
        const canonicalAudio = canonicalizeBase64(audioDelta);
        if (!canonicalAudio) {
          throw new XaiRealtimeMalformedAudioError(
            "xAI realtime voice stream returned malformed base64 audio data",
          );
        }
        this.emitAudioWithPlaybackMark(Buffer.from(canonicalAudio, "base64"));
        if (event.item_id && event.item_id !== this.lastAssistantItemId) {
          this.lastAssistantItemId = event.item_id;
          this.responseStartTimestamp = this.latestMediaTimestamp;
        } else if (this.responseStartTimestamp === null) {
          this.responseStartTimestamp = this.latestMediaTimestamp;
        }
        this.responseActive = true;
        return;
      }
      case "input_audio_buffer.speech_started":
        this.handleServerVadBargeIn();
        return;
      case "response.text.delta":
      case "response.output_text.delta":
      case "response.output_audio_transcript.delta":
        if (event.delta) {
          this.appendAssistantTranscriptDelta(event.delta);
        }
        return;
      case "response.text.done":
      case "response.output_text.done":
      case "response.output_audio_transcript.done":
        this.flushAssistantTranscript(event.transcript ?? event.text);
        return;
      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.config.onTranscript?.("user", event.delta, false);
        }
        return;
      case "conversation.item.input_audio_transcription.updated":
        if (event.transcript) {
          this.inputTranscriptReplacements.set(this.inputTranscriptKey(event), event.transcript);
        }
        return;
      case "conversation.item.input_audio_transcription.completed": {
        const key = this.inputTranscriptKey(event);
        const transcript = event.transcript ?? this.inputTranscriptReplacements.get(key);
        this.inputTranscriptReplacements.delete(key);
        if (transcript) {
          this.config.onTranscript?.("user", transcript, true);
        }
        return;
      }
      case "conversation.item.input_audio_transcription.failed":
        this.inputTranscriptReplacements.delete(this.inputTranscriptKey(event));
        this.config.onError?.(new Error(readXaiRealtimeErrorDetail(event.error)));
        return;
      case "response.done": {
        const status = event.response?.status;
        const output = Array.isArray(event.response?.output)
          ? event.response.output.filter(isRecord)
          : [];
        try {
          if (status === undefined || status === "completed") {
            for (const item of output) {
              this.emitCompletedToolCall(item, event);
            }
          }
          const terminalTranscript = output
            .filter((item) => item.type === "message" && item.role === "assistant")
            .flatMap((item) => (Array.isArray(item.content) ? item.content.filter(isRecord) : []))
            .map((content) =>
              typeof content.transcript === "string"
                ? content.transcript
                : typeof content.text === "string"
                  ? content.text
                  : "",
            )
            .join("");
          this.flushAssistantTranscript(terminalTranscript);
          if (status === "failed" || status === "incomplete") {
            const details = event.response?.status_details;
            const error = isRecord(details) ? details.error : undefined;
            const reason = isRecord(details) ? normalizeOptionalString(details.reason) : undefined;
            const message = error
              ? readXaiRealtimeErrorDetail(error)
              : `xAI realtime voice response ${status}${reason ? `: ${reason}` : ""}`;
            this.config.onError?.(new Error(message));
          }
        } finally {
          // Keep the response active through terminal tool discovery: callbacks can
          // submit results synchronously and must not start the next response early.
          this.responseActive = false;
          this.responseCreateInFlight = false;
          this.responseCancelInFlight = false;
          this.flushPendingResponseCreate();
        }
        return;
      }
      case "response.function_call_arguments.delta": {
        const key = event.item_id ?? "unknown";
        const existing = this.toolCallBuffers.get(key);
        if (existing && event.delta) {
          existing.args += event.delta;
        } else if (event.item_id) {
          this.toolCallBuffers.set(event.item_id, {
            name: event.name ?? "",
            callId: event.call_id ?? "",
            args: event.delta ?? "",
          });
        }
        return;
      }
      case "response.function_call_arguments.done": {
        const key = event.item_id ?? "unknown";
        const buffered = this.toolCallBuffers.get(key);
        // xAI's documented Function Call Flow requires executing finalized
        // arguments immediately so tool results can continue the response.
        this.emitToolCallOnce({
          itemId: event.item_id,
          callId: buffered?.callId || event.call_id,
          name: buffered?.name || event.name,
          // The done payload owns the final JSON; streamed chunks may be stale or incomplete.
          rawArgs: event.arguments ?? buffered?.args,
        });
        this.toolCallBuffers.delete(key);
        return;
      }
      case "error":
        this.handleErrorEvent(event.error);
      default:
    }
  }

  protected resetInputTranscripts(): void {
    this.inputTranscriptReplacements.clear();
  }

  private emitCompletedToolCall(item: XaiRealtimeEvent["item"], event: XaiRealtimeEvent): void {
    if (item?.type === "function_call" && (!item.status || item.status === "completed")) {
      // Completed items and resumed replay are authoritative; added items can
      // still be in progress and must not dispatch incomplete arguments.
      this.emitToolCallOnce({
        itemId: item.id ?? event.item_id,
        callId: item.call_id,
        name: item.name,
        rawArgs: item.arguments,
      });
    }
  }

  private appendAssistantTranscriptDelta(delta: string): void {
    if (this.assistantTranscriptFinalized) {
      this.assistantTranscriptBuffer = "";
      this.assistantTranscriptFinalized = false;
    }
    this.assistantTranscriptBuffer += delta;
    this.config.onTranscript?.("assistant", delta, false);
  }

  private flushAssistantTranscript(finalTranscript?: string): void {
    if (this.assistantTranscriptFinalized) {
      return;
    }
    const transcript = finalTranscript || this.assistantTranscriptBuffer;
    if (transcript) {
      this.config.onTranscript?.("assistant", transcript, true);
      this.assistantTranscriptFinalized = true;
    }
    this.assistantTranscriptBuffer = "";
  }

  private resetAssistantTranscript(): void {
    this.assistantTranscriptBuffer = "";
    this.assistantTranscriptFinalized = false;
  }

  private inputTranscriptKey(event: XaiRealtimeEvent): string {
    return event.item_id ?? event.response_id ?? "default";
  }

  private handleErrorEvent(error: unknown): void {
    const detail = readXaiRealtimeErrorDetail(error);
    if (detail.startsWith(XAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX)) {
      this.responseActive = true;
      this.responseCreateInFlight = false;
      this.responseCreatePending = true;
      return;
    }
    if (detail === XAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR) {
      this.responseActive = false;
      this.responseCancelInFlight = false;
      this.flushPendingResponseCreate();
      return;
    }
    this.config.onError?.(new Error(detail));
  }

  private describeServerEvent(event: XaiRealtimeEvent): string | undefined {
    if (
      event.type === "error" ||
      event.type === "conversation.item.input_audio_transcription.failed"
    ) {
      return readXaiRealtimeErrorDetail(event.error);
    }
    if (event.type !== "response.done") {
      return undefined;
    }
    const status = event.response?.status;
    const details =
      event.response?.status_details === undefined
        ? undefined
        : JSON.stringify(event.response.status_details);
    return (
      [status ? `status=${status}` : undefined, details].filter(Boolean).join(" ") || undefined
    );
  }
}
