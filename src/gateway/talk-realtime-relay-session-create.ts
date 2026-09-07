import { randomUUID } from "node:crypto";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../talk/agent-consult-tool.js";
import { buildRealtimeVoiceAgentCancelProviderResult } from "../talk/agent-run-control-shared.js";
import { projectInternalRealtimeVoicePublicConfig } from "../talk/provider-internal.js";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceAudioClearReason,
  type RealtimeVoiceCloseReason,
} from "../talk/provider-types.js";
import { createRealtimeVoiceSessionHarness } from "../talk/realtime-session-harness.js";
import type { TalkEventInput } from "../talk/talk-session-controller.js";
import { VOICE_TRANSCRIPT_QUEUE_POLICY } from "../talk/voice-transcript.js";
import { createTalkClientAgentConsultRunner } from "./talk-client-agent-consult.js";
import { createTalkRealtimeRunControlOwner } from "./talk-client-gateway-control.js";
import { bindTalkRealtimeRelayAgentConsult } from "./talk-realtime-relay-agent-consult.js";
import {
  buildAlreadyDeliveredToolResult,
  scheduleForcedAgentConsult,
  submitForcedConsultProviderResult,
  submitRealtimeAgentConsultWorkingResponse,
} from "./talk-realtime-relay-forced-consults.js";
import {
  buildTalkRealtimeRelayIssuePayload as relayIssuePayload,
  createTalkRealtimeRelayIssue as realtimeRelayIssue,
  projectTalkRealtimeRelayProviderError as projectError,
} from "./talk-realtime-relay-issues.js";
import {
  cancelTalkRealtimeRelayProviderToolCall,
  closeRelaySession,
  closeTalkRealtimeRelaySessionsForConnection,
  enforceRelaySessionLimits,
  pruneInactiveRelayAgentRuns,
  registerTalkRealtimeRelayAgentRun,
  resetTalkRealtimeRelayContinuity,
  prepareTalkRealtimeRelayAgentControl,
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
  TalkRealtimeRelayOutputOwnership,
  type TalkRealtimeRelayEventPayload,
  type TalkRealtimeRelaySessionResult,
} from "./talk-realtime-relay-state.js";
import {
  MAX_RELAY_TOOL_CALL_IDENTITIES,
  MAX_RELAY_TOOL_CALL_IDENTITY_BYTES,
  RelayToolCallLedger,
} from "./talk-realtime-relay-tool-call-ledger.js";
import { enqueueRelayVoiceTranscript } from "./talk-realtime-relay-voice.js";
import { registerTalkConnectionCleanup } from "./talk-session-registry.js";

// The relay contract is 20 ms of 24 kHz mono PCM16 per browser event.
const RELAY_OUTPUT_AUDIO_FRAME_BYTES = 960;

function isRelayAssistantEchoTranscript(session: RelaySession | undefined, text: string): boolean {
  return session?.harness.isLikelyAssistantEchoTranscript(text) ?? false;
}

/** Creates a realtime voice relay session and returns the browser audio contract. */
export function createTalkRealtimeRelaySession(
  params: CreateTalkRealtimeRelaySessionParams,
): TalkRealtimeRelaySessionResult {
  enforceRelaySessionLimits(params.connId);
  const publicModel = projectInternalRealtimeVoicePublicConfig({
    provider: params.provider,
    providerConfig: params.providerConfig,
    config: { model: params.model },
  }).model;
  const opaqueRoute =
    typeof params.model === "string" && params.model.length > 0 && publicModel !== params.model;
  const publicError = (error: unknown) => projectError(params.provider.id, opaqueRoute, error);
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
  let playbackTurnId: string | undefined;
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
  const clearPlayback = (reason?: RealtimeVoiceAudioClearReason) => {
    // Released clients match clear to the audio sent, which can outlive response completion
    // and remain queued after a newer response starts without sending audio.
    const turnId = playbackTurnId;
    playbackTurnId = undefined;
    emit(
      { relaySessionId, type: "clear", ...(reason ? { reason } : {}) },
      turnId
        ? { type: "output.audio.done", turnId, payload: { reason: reason ?? "clear" }, final: true }
        : undefined,
    );
  };
  const bridgeRef: { current?: ReturnType<typeof harness.createBridge> } = {};
  const outputOwnership = new TalkRealtimeRelayOutputOwnership(
    () => harness.talk.activeTurnId,
    () => harness.ensureTurn(),
    (message) => {
      const relay = getActiveRelay();
      relay?.failSession(message);
      if (!relay) {
        constructionTerminal.current ??= { kind: "error", error: new Error(message) };
      }
    },
  );
  const { agentId: relayAgentId, canonicalKey } = params.sessionTarget;
  const consultRunner = createTalkClientAgentConsultRunner({
    config: params.cfg ?? params.context.getRuntimeConfig(),
    context: params.context,
    sessionTarget: params.sessionTarget,
    ownerConnId: params.connId,
    authority: params.consultAuthority,
    getVoiceSessionId: () => relaySessionId,
    initialItems: [],
    runIdPrefix: "talk-realtime-relay-consult",
    surface: "a gateway-relay Talk session",
    registerRun: ({ runId }) => {
      if (!getActiveRelay()) {
        throw new Error("Realtime gateway-relay session is closed");
      }
      registerTalkRealtimeRelayAgentRun({
        relaySessionId,
        connId: params.connId,
        sessionKey: canonicalKey,
        runId,
      });
    },
    isRunCurrent: (runId) => getActiveRelay()?.activeAgentRuns.get(runId) === canonicalKey,
  });
  const runAgentConsult = bindTalkRealtimeRelayAgentConsult(
    consultRunner.runPrompt,
    () => getActiveRelay() !== undefined,
  );
  const runControl = createTalkRealtimeRunControlOwner({
    controlSource: params.controlSource,
    supportsToolCalls: params.supportsToolCalls,
    hasActiveRun: () => {
      const relay = getActiveRelay();
      return Boolean(relay && pruneInactiveRelayAgentRuns(relay) > 0);
    },
    prepare: (args) => {
      const relay = getActiveRelay();
      if (!relay || !args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("Realtime relay control session is closed");
      }
      const text = (args as { text?: unknown }).text;
      if (typeof text !== "string") {
        throw new Error("Realtime relay control text is required");
      }
      return prepareTalkRealtimeRelayAgentControl({
        relaySessionId,
        connId: params.connId,
        text,
      });
    },
    speak: (message) => {
      if (getActiveRelay()) {
        bridgeRef.current?.sendUserMessage?.(message);
      }
    },
    warn: (message) => {
      if (getActiveRelay()) {
        params.context.logGateway.warn(message);
      }
    },
  });
  const relayProvider = outputOwnership.bind(params.provider, runAgentConsult);
  const bridgeRequest: Parameters<typeof harness.createBridge>[0] = {
    provider: relayProvider,
    cfg: params.cfg,
    agentId: relayAgentId,
    providerConfig: params.providerConfig,
    audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    instructions: params.instructions,
    language: params.language,
    autoRespondToAudio: !forceAgentConsultOnFinalTranscript,
    interruptResponseOnInputAudio: !forceAgentConsultOnFinalTranscript,
    tools: params.tools,
    ...(runControl.handleDelegationInput
      ? {
          handleDelegationInput: (text, respond) => {
            const relay = getActiveRelay();
            if (!relay) {
              return "control";
            }
            return runControl.handleDelegationInput!(text, (message) => {
              if (getActiveRelay() === relay) {
                respond(message);
              }
            });
          },
        }
      : {}),
    markStrategy: "transport",
    audioSink: {
      isOpen: () => Boolean(getActiveRelay()),
      sendAudio: (audio) => {
        const relay = getActiveRelay();
        if (!relay) {
          return;
        }
        if (outputOwnership.phase === "cancelling") {
          return;
        }
        const outputTurnId = outputOwnership.resolve(true);
        if (!outputTurnId) {
          return;
        }
        for (let offset = 0; offset < audio.byteLength; offset += RELAY_OUTPUT_AUDIO_FRAME_BYTES) {
          const frame = audio.subarray(
            offset,
            Math.min(offset + RELAY_OUTPUT_AUDIO_FRAME_BYTES, audio.byteLength),
          );
          playbackTurnId = outputTurnId;
          emit(
            {
              relaySessionId,
              type: "audio",
              audioBase64: frame.toString("base64"),
              ...(currentOutputItemId ? { itemId: currentOutputItemId } : {}),
              ...(outputOwnership.responseId ? { responseId: outputOwnership.responseId } : {}),
            },
            {
              type: "output.audio.delta",
              turnId: outputTurnId,
              payload: { byteLength: frame.byteLength },
            },
          );
        }
      },
      clearAudio: clearPlayback,
      sendMark: (markName) => {
        const relay = getActiveRelay();
        if (!relay) {
          return;
        }
        const outputTurnId = outputOwnership.resolve(false);
        if (!outputTurnId) {
          if (outputOwnership.phase !== "owned") {
            bridgeRef.current?.acknowledgeMark(markName);
          }
          return;
        }
        emit(
          { relaySessionId, type: "mark", markName },
          {
            type: "output.audio.done",
            turnId: outputTurnId,
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
        outputOwnership.outputGeneration += 1;
        outputOwnership.drain?.resolve();
        outputOwnership.phase = "unowned";
        outputOwnership.turnId = outputOwnership.responseId = undefined;
        const activeTurnId = relay.harness.talk.activeTurnId;
        // Queued audio A and active turn B need distinct clears. Emit A before cancelling B
        // so the Talk event sequence and client cancellation fence retain their ordering.
        if (!activeTurnId || (playbackTurnId && playbackTurnId !== activeTurnId)) {
          clearPlayback();
        }
        const talkEvent = resetTalkRealtimeRelayContinuity(relay, event.type);
        if (!getActiveRelay()) {
          return;
        }
        playbackTurnId = undefined;
        if (talkEvent) {
          broadcastToOwner(params.context, params.connId, {
            relaySessionId,
            type: "clear",
            talkEvent,
          });
        }
        return;
      }
      if (event.direction !== "server") {
        return;
      }
      if (event.type === "response.created") {
        // Response admission owns work status; asynchronous input transcripts do not.
        const turnId = outputOwnership.resolve(false);
        if (turnId) {
          emit({ relaySessionId, type: "responseStarted", turnId });
        }
        return;
      }
      if (event.type === "session.created") {
        continuityResetActive = false;
      }
      if (
        (event.type === "response.done" || event.type === "response.cancelled") &&
        outputOwnership.finish(event.responseId, true) === "cancelled"
      ) {
        currentOutputItemId = undefined;
        return;
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
        outputOwnership.responseId = event.responseId ?? outputOwnership.responseId;
      }
    },
    onResponseDone: (outcome) => {
      const relay = getActiveRelay();
      if (!relay) {
        return;
      }
      const responseId = outcome.responseId ?? outputOwnership.responseId;
      const disposition = outputOwnership.finish(responseId);
      if (disposition === "ignore") {
        return;
      }
      if (disposition === "cancelled") {
        currentOutputItemId = undefined;
        return;
      }
      const terminalTalkEvent = harness.talk.recentEvents.at(-1);
      broadcastToOwner(params.context, params.connId, {
        relaySessionId,
        type: "audioDone",
        ...(currentOutputItemId ? { itemId: currentOutputItemId } : {}),
        ...(responseId ? { responseId } : {}),
        ...(terminalTalkEvent &&
        (terminalTalkEvent.type === "turn.ended" || terminalTalkEvent.type === "turn.cancelled")
          ? { talkEvent: terminalTalkEvent }
          : {}),
      });
      currentOutputItemId = undefined;
      if (outcome.status === "failed" || outcome.status === "incomplete") {
        const issue = realtimeRelayIssue({
          message: publicError(outcome.error ?? outcome),
          provider: params.provider.id,
          model: publicModel,
          phase: "response",
        });
        const errorTalkEvent = harness.talk.recentEvents.findLast(
          (event) => event.type === "session.error" && event.payload === outcome,
        );
        broadcastToOwner(params.context, params.connId, {
          ...relayIssuePayload(relaySessionId, issue),
          ...(errorTalkEvent ? { talkEvent: { ...errorTalkEvent, payload: issue } } : {}),
        });
      }
    },
    onTranscript: (role, text, final) => {
      const relay = getActiveRelay();
      if (!relay) {
        return;
      }
      if (role === "assistant" && outputOwnership.phase === "cancelling") {
        return;
      }
      if (final && !enqueueRelayVoiceTranscript(relay, role, text)) {
        return;
      }
      const outputTurnId = role === "assistant" ? outputOwnership.resolve(true) : undefined;
      if (role === "assistant" && !outputTurnId) {
        return;
      }
      const turnId = outputTurnId ?? ensureRelayTurn(relay);
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
      if (params.controlSource === "transcript" && role === "user" && final && text.trim()) {
        const question = text.trim();
        if (isRelayAssistantEchoTranscript(relay, question)) {
          return;
        }
        if (runControl.handleSpoken(question)) {
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
      if (outputOwnership.phase === "cancelling") {
        return;
      }
      const outputTurnId = outputOwnership.resolve(true);
      if (!outputTurnId) {
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
          turnId: outputTurnId,
          payload: { name: toolCall.name, args: toolCall.args },
        },
      );
      if (shouldSubmitWorkingResult) {
        return submitRealtimeAgentConsultWorkingResponse(relay, relayCallId, outputTurnId);
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
        message: publicError(error),
        provider: params.provider.id,
        model: publicModel,
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
      void runControl.close();
      const active = getActiveRelay();
      if (!active) {
        if (!relayRef.current) {
          constructionTerminal.current ??= { kind: "close", reason };
        }
        return;
      }
      if (!ready && !failureEmitted) {
        const issue = realtimeRelayIssue({
          message: "Realtime provider closed before the session became ready.",
          provider: params.provider.id,
          model: publicModel,
          phase: "connect",
        });
        emit(relayIssuePayload(relaySessionId, issue), {
          type: "session.error",
          payload: issue,
          final: true,
        });
      }
      closeRelaySession(active, reason);
    },
  };
  let bridgeResult:
    | { ok: true; bridge: ReturnType<typeof harness.createBridge> }
    | { ok: false; error: unknown };
  try {
    bridgeResult = { ok: true, bridge: harness.createBridge(bridgeRequest) };
  } catch (error) {
    bridgeResult = { ok: false, error };
  }
  if (!bridgeResult.ok) {
    throw new Error(publicError(bridgeResult.error));
  }
  const bridge = bridgeResult.bridge;
  bridgeRef.current = bridge;
  const earlyTerminal = constructionTerminal.current;
  if (earlyTerminal) {
    harness.close();
    try {
      bridge.close();
    } catch {
      params.context.logGateway.warn(
        "failed to close realtime relay bridge after provider terminated during creation: Realtime provider error.",
      );
    }
    if (earlyTerminal.kind === "error") {
      throw new Error(publicError(earlyTerminal.error));
    }
    throw new Error(`Realtime provider closed during session creation: ${earlyTerminal.reason}`);
  }
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
    getToolAuthorityOverlay: consultRunner.getToolAuthorityOverlay,
    id: relaySessionId,
    connId: params.connId,
    context: params.context,
    bridge,
    harness,
    outputOwnership,
    sessionTarget: params.sessionTarget,
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
      message: publicError(error),
      provider: params.provider.id,
      model: publicModel,
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
    ...(publicModel ? { model: publicModel } : {}),
    ...(params.voice ? { voice: params.voice } : {}),
    expiresAt: Math.floor(expiresAtMs / 1000),
  };
}
