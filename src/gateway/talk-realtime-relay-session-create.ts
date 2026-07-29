import { randomUUID } from "node:crypto";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import { formatErrorMessage } from "../infra/errors.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../talk/agent-consult-tool.js";
import { buildRealtimeVoiceAgentCancelProviderResult } from "../talk/agent-run-control-shared.js";
import {
  buildRealtimeVoiceAgentControlSpeechMessage,
  shouldAutoControlRealtimeVoiceAgentText,
} from "../talk/agent-run-control.js";
import { resolveTalkSessionAgentId } from "../talk/agent-target.js";
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "../talk/provider-types.js";
import { createRealtimeVoiceSessionHarness } from "../talk/realtime-session-harness.js";
import type { TalkEventInput } from "../talk/talk-session-controller.js";
import {
  buildAlreadyDeliveredToolResult,
  scheduleForcedAgentConsult,
  submitForcedConsultProviderResult,
  submitRealtimeAgentConsultWorkingResponse,
} from "./talk-realtime-relay-forced-consults.js";
import {
  buildTalkRealtimeRelayIssuePayload as relayIssuePayload,
  createTalkRealtimeRelayIssue as realtimeRelayIssue,
} from "./talk-realtime-relay-issues.js";
import {
  abortRelayAgentRuns,
  closeRelaySession,
  enforceRelaySessionLimits,
  pruneInactiveRelayAgentRuns,
  steerTalkRealtimeRelayAgentRun,
} from "./talk-realtime-relay-operations.js";
import { suppressedToolResultOptions } from "./talk-realtime-relay-provider-results.js";
import {
  RELAY_SESSION_TTL_MS,
  RELAY_TRANSCRIPT_ECHO_LOOKBACK_MS,
  broadcastToOwner,
  ensureRelayTurn,
  relayEventDeliveryOptions,
  relaySessions,
  type CreateTalkRealtimeRelaySessionParams,
  type RelaySession,
  type TalkRealtimeRelayEventPayload,
  type TalkRealtimeRelaySessionResult,
} from "./talk-realtime-relay-state.js";
import {
  closeRelayVoiceSession,
  enqueueRelayVoiceTranscript,
} from "./talk-realtime-relay-voice.js";
import { forgetUnifiedTalkSession } from "./talk-session-registry.js";

function isRelayAssistantEchoTranscript(session: RelaySession | undefined, text: string): boolean {
  return session?.harness.isLikelyAssistantEchoTranscript(text) ?? false;
}

/** Creates a realtime voice relay session and returns the browser audio contract. */
export function createTalkRealtimeRelaySession(
  params: CreateTalkRealtimeRelaySessionParams,
): TalkRealtimeRelaySessionResult {
  enforceRelaySessionLimits(params.connId);
  const forceAgentConsultOnFinalTranscript = params.forceAgentConsultOnFinalTranscript === true;
  const relaySessionId = randomUUID();
  const expiresAtMs = resolveExpiresAtMsFromDurationMs(RELAY_SESSION_TTL_MS);
  if (expiresAtMs === undefined) {
    throw new Error("Realtime relay session expiry is outside the supported Date range");
  }
  const harness = createRealtimeVoiceSessionHarness({
    talk: {
      sessionId: relaySessionId,
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: params.provider.id,
      // Keep the pre-harness steering window; other harness consumers use the shared default.
      maxRecentEvents: 20,
    },
    talkPayloads: {
      turnStarted: () => ({}),
      turnEnded: (reason) => ({ reason }),
      inputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
      outputAudioStarted: () => ({}),
      outputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
      outputAudioDone: (reason) => ({ reason }),
    },
    transcriptLookbackMs: RELAY_TRANSCRIPT_ECHO_LOOKBACK_MS,
    captureBridgeEvents: false,
  });
  const emit = (event: TalkRealtimeRelayEventPayload, talkEvent?: TalkEventInput) =>
    broadcastToOwner(
      params.context,
      params.connId,
      {
        ...event,
        ...(talkEvent ? { talkEvent: harness.emit(talkEvent) } : {}),
      },
      relayEventDeliveryOptions(event),
    );
  let currentOutputItemId: string | undefined;
  let currentOutputResponseId: string | undefined;
  let ready = false;
  let failureEmitted = false;
  const relayRef: { current?: RelaySession } = {};
  const bridge = harness.createBridge({
    provider: params.provider,
    cfg: params.cfg,
    providerConfig: params.providerConfig,
    audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    instructions: params.instructions,
    language: params.language,
    autoRespondToAudio: !forceAgentConsultOnFinalTranscript,
    interruptResponseOnInputAudio: !forceAgentConsultOnFinalTranscript,
    tools: params.tools,
    markStrategy: "transport",
    audioSink: {
      isOpen: () => Boolean(relayRef.current && relaySessions.has(relayRef.current.id)),
      sendAudio: (audio) => {
        const turnId = relayRef.current ? ensureRelayTurn(relayRef.current) : undefined;
        emit(
          {
            relaySessionId,
            type: "audio",
            audioBase64: audio.toString("base64"),
            ...(currentOutputItemId ? { itemId: currentOutputItemId } : {}),
            ...(currentOutputResponseId ? { responseId: currentOutputResponseId } : {}),
          },
          {
            type: "output.audio.delta",
            turnId,
            payload: { byteLength: audio.length },
          },
        );
      },
      clearAudio: (reason) => {
        const turnId = relayRef.current ? ensureRelayTurn(relayRef.current) : undefined;
        emit(
          { relaySessionId, type: "clear", ...(reason ? { reason } : {}) },
          {
            type: "output.audio.done",
            turnId,
            payload: { reason: reason ?? "clear" },
            final: true,
          },
        );
      },
      sendMark: (markName) => {
        const turnId = relayRef.current ? ensureRelayTurn(relayRef.current) : undefined;
        emit(
          { relaySessionId, type: "mark", markName },
          {
            type: "output.audio.done",
            turnId,
            payload: { markName },
            final: true,
          },
        );
      },
    },
    onEvent: (event) => {
      if (event.direction !== "server") {
        return;
      }
      if (
        event.type === "conversation.output_audio.delta" ||
        event.type === "response.audio.delta" ||
        event.type === "response.output_audio.delta"
      ) {
        currentOutputItemId = event.itemId ?? currentOutputItemId;
        currentOutputResponseId = event.responseId ?? currentOutputResponseId;
        return;
      }
      if (
        event.type === "response.audio.done" ||
        event.type === "response.output_audio.done" ||
        event.type === "conversation.output_audio.done" ||
        event.type === "response.done" ||
        event.type === "response.cancelled"
      ) {
        emit({
          relaySessionId,
          type: "audioDone",
          ...((event.itemId ?? currentOutputItemId)
            ? { itemId: event.itemId ?? currentOutputItemId }
            : {}),
          ...((event.responseId ?? currentOutputResponseId)
            ? { responseId: event.responseId ?? currentOutputResponseId }
            : {}),
        });
        currentOutputItemId = undefined;
        currentOutputResponseId = undefined;
      }
    },
    onTranscript: (role, text, final) => {
      const relay = relayRef.current;
      const turnId = relay ? ensureRelayTurn(relay) : undefined;
      if (final && relay) {
        enqueueRelayVoiceTranscript(relay, role, text);
      }
      const eventType =
        role === "assistant"
          ? final
            ? "output.text.done"
            : "output.text.delta"
          : final
            ? "transcript.done"
            : "transcript.delta";
      const payload = role === "assistant" ? { text } : { role, text };
      emit(
        { relaySessionId, type: "transcript", role, text, final },
        {
          type: eventType,
          turnId,
          payload,
          final,
        },
      );
      if (role === "user" && final && text.trim()) {
        const question = text.trim();
        if (isRelayAssistantEchoTranscript(relay, question)) {
          return;
        }
        if (
          relay &&
          pruneInactiveRelayAgentRuns(relay) > 0 &&
          shouldAutoControlRealtimeVoiceAgentText(question)
        ) {
          // While an agent consult is active, short user utterances like "stop"
          // steer the chat run instead of becoming a new consult.
          void steerTalkRealtimeRelayAgentRun({
            relaySessionId,
            connId: params.connId,
            text: question,
          })
            .then((result) => {
              if (result.speak && !result.suppress && result.message.trim()) {
                bridge.sendUserMessage(buildRealtimeVoiceAgentControlSpeechMessage(result.message));
              }
            })
            .catch((error: unknown) => {
              emit(
                { relaySessionId, type: "error", message: formatErrorMessage(error) },
                {
                  type: "session.error",
                  payload: { message: formatErrorMessage(error) },
                  final: true,
                },
              );
            });
          return;
        }
        if (forceAgentConsultOnFinalTranscript) {
          scheduleForcedAgentConsult(relay, question);
        }
      }
    },
    onToolCall: (toolCall) => {
      const relay = relayRef.current;
      let shouldSubmitWorkingResult = false;
      if (relay && toolCall.name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
        const forcedConsult = relay.harness.forcedConsults.recordNativeConsult(
          toolCall.args,
          toolCall.callId,
        );
        if (forcedConsult.kind === "in_flight" || forcedConsult.kind === "already_delivered") {
          if (forcedConsult.kind === "already_delivered") {
            const result = relay.harness.forcedConsults.isCancelled(forcedConsult.handle)
              ? buildRealtimeVoiceAgentCancelProviderResult(
                  "OpenClaw cancelled this consult before completion. Do not restart it.",
                )
              : buildAlreadyDeliveredToolResult();
            return submitForcedConsultProviderResult(
              relay,
              toolCall.callId,
              result,
              suppressedToolResultOptions(relay),
            );
          }
          if (relay.forcedTerminalProviderResults.has(forcedConsult.handle.id)) {
            return relay.pendingFinalToolResults.get(forcedConsult.handle.id);
          }
          return submitRealtimeAgentConsultWorkingResponse(relay, toolCall.callId);
        }
        shouldSubmitWorkingResult = true;
      }
      const turnId = relay ? ensureRelayTurn(relay) : undefined;
      emit(
        {
          relaySessionId,
          type: "toolCall",
          itemId: toolCall.itemId,
          callId: toolCall.callId,
          name: toolCall.name,
          args: toolCall.args,
        },
        {
          type: "tool.call",
          itemId: toolCall.itemId,
          callId: toolCall.callId,
          turnId,
          payload: { name: toolCall.name, args: toolCall.args },
        },
      );
      if (relay && shouldSubmitWorkingResult) {
        return submitRealtimeAgentConsultWorkingResponse(relay, toolCall.callId, turnId);
      }
    },
    onReady: () => {
      ready = true;
      emit({ relaySessionId, type: "ready" }, { type: "session.ready", payload: null });
    },
    onError: (error) => {
      const issue = realtimeRelayIssue({
        message: formatErrorMessage(error),
        provider: params.provider.id,
        model: params.model,
        phase: ready ? "stream" : "connect",
      });
      failureEmitted = true;
      emit(relayIssuePayload(relaySessionId, issue), {
        type: "session.error",
        payload: issue,
        final: true,
      });
    },
    onClose: (reason) => {
      const active = relaySessions.get(relaySessionId);
      if (!active) {
        return;
      }
      active.harness.close();
      relaySessions.delete(relaySessionId);
      forgetUnifiedTalkSession(relaySessionId);
      clearTimeout(active.cleanupTimer);
      abortRelayAgentRuns(active, "relay-closed");
      closeRelayVoiceSession(active);
      if (!ready && !failureEmitted) {
        const issue = realtimeRelayIssue({
          message: "Realtime provider closed before the session became ready.",
          provider: params.provider.id,
          model: params.model,
          phase: "connect",
        });
        emit(relayIssuePayload(relaySessionId, issue), {
          type: "session.error",
          payload: issue,
          final: true,
        });
      }
      emit(
        { relaySessionId, type: "close", reason },
        { type: "session.closed", payload: { reason }, final: true },
      );
    },
  });
  const initialSessionKey = params.sessionKey?.trim() || undefined;
  const relay: RelaySession = {
    id: relaySessionId,
    connId: params.connId,
    context: params.context,
    bridge,
    harness,
    sessionKey: initialSessionKey,
    ...(initialSessionKey
      ? {
          agentId: resolveTalkSessionAgentId(
            params.cfg ?? params.context.getRuntimeConfig(),
            initialSessionKey,
          ),
        }
      : {}),
    expiresAtMs,
    cleanupTimer: setTimeout(() => {
      const active = relaySessions.get(relaySessionId);
      if (active) {
        closeRelaySession(active, "completed");
      }
    }, RELAY_SESSION_TTL_MS),
    activeAgentRuns: new Map(),
    provider: params.provider.id,
    activeAgentToolCalls: new Map(),
    completedAgentToolCalls: new Set(),
    cancelledAgentToolCalls: new Map(),
    pendingFinalToolResults: new Map(),
    completedProviderToolResults: new Set(),
    pendingProviderToolResults: new Map(),
    pendingWorkingToolResults: new Map(),
    forcedTerminalProviderResults: new Map(),
    toolResultEpoch: 0,
    ...(params.cfg ? { voiceConfig: params.cfg } : {}),
    voiceSessionCreated: false,
    voiceTranscriptSeq: 0,
    voiceTranscriptWrites: Promise.resolve(),
    pendingVoiceTranscripts: [],
  };
  relayRef.current = relay;
  relay.cleanupTimer.unref?.();
  relaySessions.set(relaySessionId, relay);
  bridge.connect().catch((error: unknown) => {
    const issue = realtimeRelayIssue({
      message: formatErrorMessage(error),
      provider: params.provider.id,
      model: params.model,
      phase: "connect",
    });
    failureEmitted = true;
    emit(relayIssuePayload(relaySessionId, issue), {
      type: "session.error",
      payload: issue,
      final: true,
    });
    const active = relaySessions.get(relaySessionId);
    if (active) {
      closeRelaySession(active, "error");
    }
  });

  return {
    provider: params.provider.id,
    transport: "gateway-relay",
    relaySessionId,
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz,
      outputEncoding: "pcm16",
      outputSampleRateHz: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz,
    },
    ...(params.model ? { model: params.model } : {}),
    ...(params.voice ? { voice: params.voice } : {}),
    expiresAt: Math.floor(expiresAtMs / 1000),
  };
}
