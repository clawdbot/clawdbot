import { randomUUID } from "node:crypto";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeTalkSection } from "../config/talk.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { consultRealtimeVoiceAgent } from "../talk/agent-consult-runtime.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../talk/agent-consult-tool.js";
import { buildRealtimeVoiceAgentCancelProviderResult } from "../talk/agent-run-control-shared.js";
import {
  buildRealtimeVoiceAgentControlSpeechMessage,
  shouldAutoControlRealtimeVoiceAgentText,
} from "../talk/agent-run-control.js";
import { resolveTalkSessionAgentId } from "../talk/agent-target.js";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceCloseReason,
} from "../talk/provider-types.js";
import { createRealtimeVoiceSessionHarness } from "../talk/realtime-session-harness.js";
import type { TalkEventInput } from "../talk/talk-session-controller.js";
import { VOICE_TRANSCRIPT_QUEUE_POLICY } from "../talk/voice-transcript.js";
import { registerChatAbortController } from "./chat-abort.js";
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
  cancelTalkRealtimeRelayProviderToolCall,
  closeRelaySession,
  closeTalkRealtimeRelaySessionsForConnection,
  enforceRelaySessionLimits,
  pruneInactiveRelayAgentRuns,
  registerTalkRealtimeRelayAgentRun,
  resetTalkRealtimeRelayContinuity,
  steerTalkRealtimeRelayAgentRun,
} from "./talk-realtime-relay-operations.js";
import { suppressedToolResultOptions } from "./talk-realtime-relay-provider-results.js";
import {
  RELAY_SESSION_TTL_MS,
  RELAY_TRANSCRIPT_ECHO_LOOKBACK_MS,
  adoptRelayProviderToolCallId,
  broadcastToOwner,
  ensureRelayTurn,
  relaySessions,
  type CreateTalkRealtimeRelaySessionParams,
  type RelaySession,
  type TalkRealtimeRelayEventPayload,
  type TalkRealtimeRelaySessionResult,
} from "./talk-realtime-relay-state.js";
import {
  MAX_RELAY_TOOL_CALL_IDENTITIES,
  MAX_RELAY_TOOL_CALL_IDENTITY_BYTES,
  RelayToolCallLedger,
} from "./talk-realtime-relay-tool-call-ledger.js";
import {
  closeRelayVoiceSession,
  enqueueRelayVoiceTranscript,
} from "./talk-realtime-relay-voice.js";
import {
  forgetUnifiedTalkSession,
  registerTalkConnectionCleanup,
} from "./talk-session-registry.js";

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
    broadcastToOwner(params.context, params.connId, {
      ...event,
      ...(talkEvent ? { talkEvent: harness.emit(talkEvent) } : {}),
    });
  let currentOutputItemId: string | undefined;
  let currentOutputResponseId: string | undefined;
  let ready = false;
  let continuityResetActive = false;
  let failureEmitted = false;
  let sessionFailureRequested = false;
  const constructionTerminal: {
    current?: { kind: "error"; error: Error } | { kind: "close"; reason: RealtimeVoiceCloseReason };
  } = {};
  const relayRef: { current?: RelaySession } = {};
  const getActiveRelay = (): RelaySession | undefined => {
    const relay = relayRef.current;
    return relay && relaySessions.get(relay.id) === relay ? relay : undefined;
  };
  let consultAgentRuntime: ReturnType<typeof createPluginRuntime>["agent"] | undefined;
  const relaySessionKey = params.sessionKey?.trim();
  const relayAgentId = relaySessionKey
    ? resolveTalkSessionAgentId(params.cfg ?? params.context.getRuntimeConfig(), relaySessionKey)
    : undefined;
  const runAgentConsult = async ({ prompt, signal }: { prompt: string; signal?: AbortSignal }) => {
    if (!getActiveRelay()) {
      throw new Error("Realtime gateway-relay session is closed");
    }
    const runtimeConfig = params.cfg ?? params.context.getRuntimeConfig();
    const sessionKey = relaySessionKey;
    if (!sessionKey) {
      throw new Error("Realtime gateway-relay agent consult requires a pinned session key");
    }
    const agentId = relayAgentId ?? resolveTalkSessionAgentId(runtimeConfig, sessionKey);
    consultAgentRuntime ??= createPluginRuntime().agent;
    const talkConfig = normalizeTalkSection(runtimeConfig.talk);
    return await consultRealtimeVoiceAgent({
      cfg: runtimeConfig,
      agentRuntime: consultAgentRuntime,
      logger: params.context.logGateway,
      agentId,
      sessionKey,
      messageProvider: "webchat",
      lane: "talk",
      runIdPrefix: "talk-realtime-relay-consult",
      args: { question: prompt },
      transcript: [],
      surface: "a gateway-relay Talk session",
      userLabel: "User",
      questionSourceLabel: "user",
      thinkLevel: talkConfig?.consultThinkingLevel,
      fastMode: talkConfig?.consultFastMode,
      abortSignal: signal,
      onRunStarted: ({ runId, sessionId, timeoutMs }) => {
        registerTalkRealtimeRelayAgentRun({
          relaySessionId,
          connId: params.connId,
          sessionKey,
          runId,
        });
        const registration = registerChatAbortController({
          chatAbortControllers: params.context.chatAbortControllers,
          runId,
          sessionId,
          sessionKey,
          agentId,
          timeoutMs,
          ownerConnId: params.connId,
          controlUiVisible: false,
          kind: "chat-send",
        });
        return {
          abortSignal: registration.controller.signal,
          cleanup: registration.cleanup,
        };
      },
    });
  };
  // The generic harness should stay transport-neutral. Wrap only this relay provider
  // invocation so provider-owned delegations cannot acquire the host runner elsewhere.
  const relayProvider = {
    ...params.provider,
    createBridge: (request: Parameters<typeof params.provider.createBridge>[0]) =>
      params.provider.createBridge({
        ...request,
        ...(relayAgentId ? { agentId: relayAgentId } : {}),
        runAgentConsult,
      }),
  };
  const bridge = harness.createBridge({
    provider: relayProvider,
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
      isOpen: () => Boolean(getActiveRelay()),
      sendAudio: (audio) => {
        const relay = getActiveRelay();
        if (!relay) {
          return;
        }
        const turnId = ensureRelayTurn(relay);
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
        const relay = getActiveRelay();
        if (!relay) {
          return;
        }
        const turnId = ensureRelayTurn(relay);
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
        const relay = getActiveRelay();
        if (!relay) {
          return;
        }
        const turnId = ensureRelayTurn(relay);
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
      const relay = getActiveRelay();
      if (!relay) {
        return;
      }
      if (event.direction === "client" && event.type === "session.continuity.reset") {
        if (continuityResetActive) {
          return;
        }
        continuityResetActive = true;
        ready = false;
        currentOutputItemId = undefined;
        currentOutputResponseId = undefined;
        const talkEvent = resetTalkRealtimeRelayContinuity(relay, event.type);
        if (!getActiveRelay()) {
          return;
        }
        const clearEvent = { relaySessionId, type: "clear" as const };
        broadcastToOwner(params.context, params.connId, {
          ...clearEvent,
          ...(talkEvent ? { talkEvent } : {}),
        });
        return;
      }
      if (event.direction !== "server") {
        return;
      }
      if (event.type === "session.created") {
        continuityResetActive = false;
      }
      if (event.type === "tool.call.cancelled" && event.itemId) {
        const relayCallId = cancelTalkRealtimeRelayProviderToolCall(relay, event.itemId);
        if (relayCallId) {
          const cancelledEvent = {
            relaySessionId,
            type: "toolCallCancelled" as const,
            callId: relayCallId,
          };
          broadcastToOwner(params.context, params.connId, cancelledEvent);
        }
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
      const relay = getActiveRelay();
      if (!relay) {
        return;
      }
      if (final && !enqueueRelayVoiceTranscript(relay, role, text)) {
        return;
      }
      const turnId = ensureRelayTurn(relay);
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
              if (!getActiveRelay()) {
                return;
              }
              if (result.speak && !result.suppress && result.message.trim()) {
                bridge.sendUserMessage(buildRealtimeVoiceAgentControlSpeechMessage(result.message));
              }
            })
            .catch((error: unknown) => {
              if (!getActiveRelay()) {
                return;
              }
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
      const relay = getActiveRelay();
      if (!relay) {
        return;
      }
      const providerCallId = toolCall.callId;
      const relayCallId = adoptRelayProviderToolCallId(relay, providerCallId);
      if (!relayCallId) {
        return;
      }
      let shouldSubmitWorkingResult = false;
      if (toolCall.name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
        const forcedConsult = relay.harness.forcedConsults.recordNativeConsult(
          toolCall.args,
          providerCallId,
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
              providerCallId,
              result,
              suppressedToolResultOptions(relay),
            );
          }
          if (relay.forcedTerminalProviderResults.has(forcedConsult.handle.id)) {
            return relay.pendingFinalToolResults.get(forcedConsult.handle.id);
          }
          return submitRealtimeAgentConsultWorkingResponse(relay, relayCallId);
        }
        shouldSubmitWorkingResult = true;
      }
      const turnId = ensureRelayTurn(relay);
      emit(
        {
          relaySessionId,
          type: "toolCall",
          itemId: toolCall.itemId,
          callId: relayCallId,
          name: toolCall.name,
          args: toolCall.args,
        },
        {
          type: "tool.call",
          itemId: toolCall.itemId,
          callId: relayCallId,
          turnId,
          payload: { name: toolCall.name, args: toolCall.args },
        },
      );
      if (shouldSubmitWorkingResult) {
        return submitRealtimeAgentConsultWorkingResponse(relay, relayCallId, turnId);
      }
    },
    onReady: () => {
      if (!getActiveRelay()) {
        return;
      }
      ready = true;
      continuityResetActive = false;
      emit({ relaySessionId, type: "ready" }, { type: "session.ready", payload: null });
    },
    onError: (error) => {
      const active = getActiveRelay();
      if (!active) {
        if (!relayRef.current) {
          constructionTerminal.current ??= { kind: "error", error };
        }
        return;
      }
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
      if (!active || active !== relayRef.current) {
        if (!relayRef.current) {
          constructionTerminal.current ??= { kind: "close", reason };
        }
        return;
      }
      active.harness.close();
      relaySessions.delete(relaySessionId);
      forgetUnifiedTalkSession(relaySessionId);
      clearTimeout(active.cleanupTimer);
      abortRelayAgentRuns(active, "relay-closed");
      void closeRelayVoiceSession(active);
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
  const earlyTerminal = constructionTerminal.current;
  if (earlyTerminal) {
    harness.close();
    try {
      bridge.close();
    } catch (error) {
      params.context.logGateway.warn(
        `failed to close realtime relay bridge after provider terminated during creation: ${formatErrorMessage(error)}`,
      );
    }
    if (earlyTerminal.kind === "error") {
      throw earlyTerminal.error;
    }
    throw new Error(`Realtime provider closed during session creation: ${earlyTerminal.reason}`);
  }
  const initialSessionKey = params.sessionKey?.trim() || undefined;
  const failSession = (message: string) => {
    const active = relaySessions.get(relaySessionId);
    if (!active || sessionFailureRequested) {
      return;
    }
    sessionFailureRequested = true;
    if (!failureEmitted) {
      failureEmitted = true;
      emit(
        { relaySessionId, type: "error", message },
        {
          type: "session.error",
          payload: { message },
          final: true,
        },
      );
    }
    closeRelaySession(active, "error");
  };
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
    toolCalls: new RelayToolCallLedger({
      onOverflow: () =>
        failSession(
          `Realtime relay tool-call session limit exceeded (${MAX_RELAY_TOOL_CALL_IDENTITIES} identities or ${MAX_RELAY_TOOL_CALL_IDENTITY_BYTES} UTF-8 bytes)`,
        ),
    }),
    providerToolCallIds: new Map(),
    relayToolCallIdsByProviderId: new Map(),
    pendingFinalToolResults: new Map(),
    pendingProviderToolResults: new Map(),
    pendingWorkingToolResults: new Map(),
    forcedTerminalProviderResults: new Map(),
    toolResultEpoch: 0,
    ...(params.cfg ? { voiceConfig: params.cfg } : {}),
    voiceSessionCreated: false,
    voiceTranscriptSeq: 0,
    voiceTranscriptQueue: VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue(),
    failSession,
    pendingVoiceTranscripts: [],
  };
  relayRef.current = relay;
  relay.cleanupTimer.unref?.();
  relaySessions.set(relaySessionId, relay);
  registerTalkConnectionCleanup(params.connId, "realtime-relay", () => {
    closeTalkRealtimeRelaySessionsForConnection(params.connId);
  });
  bridge.connect().catch((error: unknown) => {
    const active = relaySessions.get(relaySessionId);
    if (active !== relay) {
      return;
    }
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
    closeRelaySession(active, "error");
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
