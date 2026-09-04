import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";
import {
  normalizeRealtimeVoiceResponseOutcome,
  type RealtimeVoiceSessionConnection,
} from "openclaw/plugin-sdk/realtime-voice";
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
  private finalizedToolCallItems = new Set<string>();
  private inputTranscriptReplacements = new Map<string, string>();

  protected abstract acceptsEvent(connection: RealtimeVoiceSessionConnection): boolean;
  protected abstract onSessionUpdated(connection: RealtimeVoiceSessionConnection): void;

  protected handleEvent(event: XaiRealtimeEvent, connection: RealtimeVoiceSessionConnection): void {
    if (event.type === "response.created" && this.acceptsEvent(connection)) {
      // Publish the response owner before observers can interrupt its first PCM.
      this.outputAudioGeneration += 1;
      this.responseActive = true;
      this.responseCreateInFlight = false;
      this.markQueue = [];
      this.assistantAudioItem = null;
      this.resetAssistantTranscript();
    }
    const audioGeneration = this.outputAudioGeneration;
    const bridgeEvent = {
      direction: "server",
      type: event.type,
      detail: this.describeServerEvent(event),
      ...(event.item_id ? { itemId: event.item_id } : {}),
      ...((event.response_id ?? event.response?.id)
        ? { responseId: event.response_id ?? event.response?.id }
        : {}),
    } as const;
    const emitBridgeEvent = () => this.config.onEvent?.(bridgeEvent);
    if (event.type !== "response.done" || !this.acceptsEvent(connection)) {
      emitBridgeEvent();
    }
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
          // Session resumption replays already-finalized conversation items without
          // another response.done; deliver that completed history at its replay boundary.
          this.emitCompletedToolCall(item, event);
        }
        return;
      }
      case "session.updated":
        this.onSessionUpdated(connection);
        return;
      case "response.output_audio.delta": {
        const audioDelta = event.delta ?? event.data;
        if (
          !audioDelta ||
          this.responseCancelInFlight ||
          audioGeneration !== this.outputAudioGeneration
        ) {
          return;
        }
        const canonicalAudio = canonicalizeBase64(audioDelta);
        if (!canonicalAudio) {
          throw new XaiRealtimeMalformedAudioError(
            "xAI realtime voice stream returned malformed base64 audio data",
          );
        }
        const audio = Buffer.from(canonicalAudio, "base64");
        if (event.item_id && event.item_id !== this.assistantAudioItem?.itemId) {
          this.assistantAudioItem = {
            itemId: event.item_id,
            bytes: audio.byteLength,
            startTimestamp: this.latestMediaTimestamp,
          };
        } else if (this.assistantAudioItem) {
          this.assistantAudioItem.bytes += audio.byteLength;
        }
        this.responseActive = true;
        const markName = this.createPlaybackMark();
        this.config.onAudio(audio, event.item_id ? { itemId: event.item_id } : undefined);
        if (audioGeneration === this.outputAudioGeneration && this.acceptsEvent(connection)) {
          this.config.onMark?.(markName, () => {
            if (this.acceptsEvent(connection)) {
              this.acknowledgeMark(markName);
            }
          });
        }
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
        const output = Array.isArray(event.response?.output)
          ? event.response.output.filter(isRecord)
          : [];
        const outcome = normalizeRealtimeVoiceResponseOutcome({
          providerLabel: "xAI realtime voice",
          response: event.response,
          responseId: event.response_id,
        });
        // Non-completed responses discard their output. Retire those marks without
        // claiming playback so they cannot block the next response indefinitely.
        if (outcome.status !== "completed") {
          this.markQueue = [];
          this.assistantAudioItem = null;
        }
        let callbackError: unknown;
        const invoke = (callback: () => void) => {
          try {
            callback();
          } catch (error) {
            callbackError ??= error;
          }
        };
        try {
          // Deliver output before completion retires its response owner. Tool callbacks
          // may close the connection, so remaining output must recheck that owner.
          invoke(() => {
            if (outcome.status === "completed") {
              for (const [itemId, toolCall] of this.toolCallBuffers) {
                if (!this.acceptsEvent(connection)) {
                  return;
                }
                this.emitToolCallOnce({
                  itemId,
                  callId: toolCall.callId,
                  name: toolCall.name,
                  rawArgs: toolCall.args,
                });
              }
              for (const item of output) {
                if (!this.acceptsEvent(connection)) {
                  return;
                }
                this.emitCompletedToolCall(item, event);
              }
            }
            if (!this.acceptsEvent(connection)) {
              return;
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
          });
          invoke(() => this.config.onResponseDone?.(outcome));
          invoke(emitBridgeEvent);
        } finally {
          // Keep the response active through terminal tool discovery: callbacks can
          // submit results synchronously and must not start the next response early.
          this.responseActive = false;
          this.responseCreateInFlight = false;
          this.responseCancelInFlight = false;
          this.toolCallBuffers.clear();
          this.finalizedToolCallItems.clear();
          this.flushPendingResponseCreate();
        }
        if (callbackError) {
          throw callbackError instanceof Error
            ? callbackError
            : new Error("xAI realtime response callback failed", { cause: callbackError });
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
        if (this.finalizedToolCallItems.has(key)) {
          return;
        }
        const buffered = this.toolCallBuffers.get(key);
        // Keep finalized arguments for diagnostics only. response.done with a completed
        // response is the authoritative execution boundary for provider tool calls.
        if (event.item_id) {
          this.finalizedToolCallItems.add(event.item_id);
          this.toolCallBuffers.set(event.item_id, {
            name: buffered?.name || event.name || "",
            callId: buffered?.callId || event.call_id || "",
            args: event.arguments ?? buffered?.args ?? "",
          });
        }
        return;
      }
      case "response.output_item.done":
        this.bufferCompletedToolCall(event.item, event);
        return;
      case "error":
        this.handleErrorEvent(event.error);
      default:
    }
  }

  protected resetInputTranscripts(): void {
    this.inputTranscriptReplacements.clear();
    this.finalizedToolCallItems.clear();
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

  private bufferCompletedToolCall(item: XaiRealtimeEvent["item"], event: XaiRealtimeEvent): void {
    if (item?.type !== "function_call" || (item.status && item.status !== "completed")) {
      return;
    }
    const itemId = item.id ?? event.item_id;
    if (!itemId) {
      return;
    }
    this.toolCallBuffers.set(itemId, {
      name: item.name ?? "",
      callId: item.call_id ?? "",
      args: item.arguments ?? "",
    });
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
