// Shared STT plus agent-consult meeting engine.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
import type { RealtimeTranscriptionSession } from "../realtime-transcription/provider-types.js";
import {
  createRealtimeVoiceSessionHarness,
  type RealtimeVoiceSessionHarness,
} from "../talk/realtime-session-harness.js";
import {
  convertMeetingBridgeAudioForStt,
  convertMeetingTtsAudioForBridge,
} from "./realtime-audio-format.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";
import {
  formatMeetingAgentAudioModelLog,
  formatMeetingAgentTtsResultLog,
  formatMeetingTranscriptSummaryLog,
  meetingOutputBytesPerMs,
  MEETING_AGENT_TRANSCRIPT_DEBOUNCE_MS,
  MEETING_OUTPUT_ECHO_SUPPRESSION_TAIL_MS,
  MEETING_TRANSCRIPT_ECHO_LOOKBACK_MS,
  normalizeMeetingTtsPromptText,
  resolveMeetingRealtimeTranscriptionProvider,
  type MeetingAgentConsultParams,
  type MeetingRealtimeAudioEngineHandle,
  type MeetingRealtimeEngineConfig,
  type MeetingRuntimePlatform,
} from "./realtime-engine.js";

export async function startMeetingAgentRealtimeEngine(params: {
  config: MeetingRealtimeEngineConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  platform: MeetingRuntimePlatform;
  meetingSessionId: string;
  requesterSessionKey?: string;
  logPrefix?: "node";
  transport: MeetingRealtimeAudioTransport;
  logger: RuntimeLogger;
  providers?: RealtimeTranscriptionProviderPlugin[];
  consultAgent: (params: MeetingAgentConsultParams) => Promise<{ text: string }>;
}): Promise<MeetingRealtimeAudioEngineHandle> {
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  let sttSession: RealtimeTranscriptionSession | null = null;
  let realtimeReady = false;
  let ttsQueue = Promise.resolve();
  const agentLogScope = params.logPrefix ? `${params.logPrefix} agent` : "agent";
  const resolved = resolveMeetingRealtimeTranscriptionProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  params.logger.info(
    formatMeetingAgentAudioModelLog({
      logScope: params.platform.logScope,
      provider: resolved.provider,
      providerConfig: resolved.providerConfig,
      audioFormat: params.config.chrome.audioFormat,
    }),
  );

  const stop = async () => {
    if (stopped) {
      await stopPromise;
      return;
    }
    stopped = true;
    stopPromise = (async () => {
      harness.close();
      try {
        sttSession?.close();
      } catch (error) {
        params.logger.debug?.(
          `${params.platform.logScope} ${agentLogScope} transcription bridge close ignored: ${formatErrorMessage(error)}`,
        );
      }
      harness.emit({
        type: "session.closed",
        final: true,
        payload: { meetingSessionId: params.meetingSessionId },
      });
      try {
        await params.transport.stop();
      } finally {
        await params.transport.dispose();
      }
    })();
    await stopPromise;
  };

  const stopAfterFailure = (source: string) => {
    void stop().catch((error: unknown) => {
      params.logger.warn(
        `${params.platform.logScope} ${agentLogScope} ${source} cleanup failed: ${formatErrorMessage(error)}`,
      );
    });
  };

  const writeOutputAudio = async (audio: Buffer) => {
    harness.outputActivity.markPlaybackStarted();
    harness.recordOutputAudio(audio);
    await params.transport.writeOutput(audio);
  };

  const enqueueSpeakText = (text: string | undefined) => {
    const normalized = normalizeMeetingTtsPromptText(text);
    if (!normalized || stopped) {
      return;
    }
    ttsQueue = ttsQueue
      .then(async () => {
        if (stopped) {
          return;
        }
        harness.recordTranscript("assistant", normalized);
        params.logger.info(
          formatMeetingTranscriptSummaryLog(
            params.platform.logScope,
            `${agentLogScope} assistant`,
            normalized,
          ),
        );
        const turnId = harness.ensureTurn();
        harness.emit({
          type: "output.text.done",
          turnId,
          final: true,
          payload: { meetingSessionId: params.meetingSessionId, text: normalized },
        });
        const result = await params.runtime.tts.textToSpeechTelephony({
          text: normalized,
          cfg: params.fullConfig,
        });
        if (!result.success || !result.audioBuffer || !result.sampleRate) {
          throw new Error(result.error ?? "TTS conversion failed");
        }
        params.logger.info(
          formatMeetingAgentTtsResultLog(params.platform.logScope, agentLogScope, result),
        );
        await writeOutputAudio(
          convertMeetingTtsAudioForBridge(
            result.audioBuffer,
            result.sampleRate,
            params.config.chrome.audioFormat,
            result.outputFormat,
            params.platform.displayName,
          ),
        );
        harness.finishOutputAudio("completed");
        harness.endTurn();
      })
      .catch((error: unknown) => {
        // TTS and sink failures happen after a turn, and sometimes output, has started.
        // Close both spans so later input cannot inherit stale playback suppression.
        harness.finishOutputAudio("failed");
        harness.endTurn("failed");
        params.logger.warn(
          `${params.platform.logScope} ${agentLogScope} TTS failed: ${formatErrorMessage(error)}`,
        );
      });
  };

  // The closures above only run after harness creation; they capture this later `const`.
  // Annotated because the consult closure references harness inside its own initializer.
  const harness: RealtimeVoiceSessionHarness = createRealtimeVoiceSessionHarness({
    talk: {
      sessionId: `${params.platform.sessionIdPrefix}:${params.meetingSessionId}:agent`,
      mode: "stt-tts",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: resolved.provider.id,
      turnIdPrefix: `${params.platform.sessionIdPrefix}:${params.meetingSessionId}:turn`,
    },
    talkPayloads: {
      turnStarted: () => ({ meetingSessionId: params.meetingSessionId }),
      turnEnded: () => ({ meetingSessionId: params.meetingSessionId }),
      inputAudioDelta: (audio) => ({
        meetingSessionId: params.meetingSessionId,
        bytes: audio.byteLength,
      }),
      outputAudioStarted: () => ({ meetingSessionId: params.meetingSessionId }),
      outputAudioDelta: (audio) => ({
        meetingSessionId: params.meetingSessionId,
        bytes: audio.byteLength,
      }),
      outputAudioDone: () => ({ meetingSessionId: params.meetingSessionId }),
    },
    echoSuppression: {
      bytesPerMs: meetingOutputBytesPerMs(params.config.chrome.audioFormat),
      tailMs: MEETING_OUTPUT_ECHO_SUPPRESSION_TAIL_MS,
      transcriptLookbackMs: MEETING_TRANSCRIPT_ECHO_LOOKBACK_MS,
    },
    talkback: {
      debounceMs: MEETING_AGENT_TRANSCRIPT_DEBOUNCE_MS,
      logger: params.logger,
      logPrefix: `${params.platform.logScope} ${agentLogScope}`,
      responseStyle: "Brief, natural spoken answer for a live meeting.",
      fallbackText: "I hit an error while checking that. Please try again.",
      consult: ({ question, responseStyle }) =>
        params.consultAgent({
          meetingSessionId: params.meetingSessionId,
          requesterSessionKey: params.requesterSessionKey,
          args: { question, responseStyle },
          transcript: harness.transcript,
        }),
      deliver: enqueueSpeakText,
    },
  });

  params.transport.onFatal(() => {
    stopAfterFailure("audio transport");
  });
  // onFatal replays a pre-registration failure synchronously; abort before creating a
  // provider session that the already-completed stop() could never close.
  if (stopped) {
    throw new Error(
      `${params.platform.displayName} audio transport failed before transcription provider setup`,
    );
  }

  try {
    sttSession = resolved.provider.createSession({
      cfg: params.fullConfig,
      providerConfig: resolved.providerConfig,
      onTranscript: (text) => {
        const trimmed = text.trim();
        if (!trimmed || stopped) {
          return;
        }
        // Shipped Meet semantics keep assistant echoes in transcript history and events.
        // Echo suppression only prevents the recorded line from entering talkback.
        const turnId = harness.ensureTurn();
        harness.emit({
          type: "input.audio.committed",
          turnId,
          final: true,
          payload: { meetingSessionId: params.meetingSessionId },
        });
        harness.emit({
          type: "transcript.done",
          turnId,
          final: true,
          payload: { meetingSessionId: params.meetingSessionId, text: trimmed, role: "user" },
        });
        harness.recordTranscript("user", trimmed);
        params.logger.info(
          formatMeetingTranscriptSummaryLog(
            params.platform.logScope,
            `${agentLogScope} user`,
            trimmed,
          ),
        );
        if (harness.isLikelyAssistantEchoTranscript(trimmed)) {
          params.logger.info(
            formatMeetingTranscriptSummaryLog(
              params.platform.logScope,
              `${agentLogScope} ignored assistant echo transcript`,
              trimmed,
            ),
          );
          return;
        }
        harness.talkback?.enqueue(trimmed);
      },
      onError: (error) => {
        params.logger.warn(
          `${params.platform.logScope} ${agentLogScope} transcription bridge failed: ${formatErrorMessage(error)}`,
        );
        harness.emit({
          type: "session.error",
          final: true,
          payload: { meetingSessionId: params.meetingSessionId, error: formatErrorMessage(error) },
        });
        stopAfterFailure("transcription bridge");
      },
    });

    harness.emit({
      type: "session.started",
      payload: { meetingSessionId: params.meetingSessionId, provider: resolved.provider.id },
    });
    // Drain transport input while connect() is pending so the capture pipe never backpressures;
    // chunks before session.ready are dropped instead of arriving later as a stale burst.
    params.transport.startInput((audio) => {
      if (stopped || !realtimeReady || audio.byteLength === 0) {
        return;
      }
      if (!harness.recordInputAudio(audio)) {
        return;
      }
      sttSession?.sendAudio(
        convertMeetingBridgeAudioForStt(audio, params.config.chrome.audioFormat),
      );
    });

    await sttSession.connect();
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      params.logger.debug?.(
        `${params.platform.logScope} ${agentLogScope} failed-start cleanup ignored: ${formatErrorMessage(cleanupError)}`,
      );
    }
    throw error;
  }
  if (stopped) {
    throw new Error(
      `${params.platform.displayName} audio transport stopped during transcription provider setup`,
    );
  }
  realtimeReady = true;
  harness.emit({
    type: "session.ready",
    payload: { meetingSessionId: params.meetingSessionId },
  });

  return {
    providerId: resolved.provider.id,
    speak: enqueueSpeakText,
    getHealth: () => ({
      ...harness.getHealth({
        providerConnected: sttSession?.isConnected() ?? false,
        realtimeReady,
      }),
      ...params.transport.getHealth?.(),
      bridgeClosed: stopped,
    }),
    stop,
  };
}
