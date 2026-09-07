// Shared STT plus agent-consult meeting engine.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  PluginRegistryResourceScope,
  createPluginRegistryResourceLease,
  getPluginRegistryResourceScope,
} from "../plugins/registry-resources.js";
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
import { MeetingRealtimeStartupCleanupError } from "./realtime-engine-error.js";
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
  /** Registers cleanup before provider construction; retain it until stop succeeds. */
  onCleanupReady?: (stop: () => Promise<void>) => void | Promise<void>;
  consultAgent: (params: MeetingAgentConsultParams) => Promise<{ text: string }>;
}): Promise<MeetingRealtimeAudioEngineHandle> {
  const resources = createPluginRegistryResourceLease(
    getPluginRegistryResourceScope()?.fork() ?? new PluginRegistryResourceScope(),
  );
  let cleanupOwned = false;
  try {
    return await resources.run(() =>
      startMeetingAgentRealtimeEngineWithResources(
        {
          ...params,
          onCleanupReady: (stop) => {
            cleanupOwned = true;
            return params.onCleanupReady?.(stop);
          },
        },
        resources,
      ),
    );
  } catch (error) {
    if (!cleanupOwned) {
      resources.release();
    }
    throw error;
  }
}

async function startMeetingAgentRealtimeEngineWithResources(
  params: Parameters<typeof startMeetingAgentRealtimeEngine>[0],
  resources: ReturnType<typeof createPluginRegistryResourceLease>,
): Promise<MeetingRealtimeAudioEngineHandle> {
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  let sessionClosed = false;
  let transportStopped = false;
  let transportDisposed = false;
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
    stopped = true;
    if (stopPromise) {
      await stopPromise;
      return;
    }
    if (sessionClosed && transportStopped && transportDisposed) {
      return;
    }
    const cleanup = resources.run(() =>
      Promise.resolve().then(async () => {
        let cleanupError: unknown;
        if (!sessionClosed) {
          harness.close();
          try {
            sttSession?.close();
            sessionClosed = true;
          } catch (error) {
            cleanupError = error;
          }
          harness.finishOutputAudio("stopped");
          harness.endTurn("stopped");
          if (sessionClosed) {
            harness.emit({
              type: "session.closed",
              final: true,
              payload: { meetingSessionId: params.meetingSessionId },
            });
          }
        }
        if (!transportStopped) {
          try {
            await params.transport.stop();
            transportStopped = true;
          } catch (error) {
            cleanupError ??= error;
          }
        }
        if (!transportDisposed) {
          try {
            await params.transport.dispose();
            transportDisposed = true;
          } catch (error) {
            cleanupError ??= error;
          }
        }
        // Failed provider closure keeps the same retry owner even after transport cleanup succeeds.
        if (!sessionClosed || !transportStopped || !transportDisposed) {
          throw cleanupError instanceof Error
            ? cleanupError
            : new Error("Meeting agent cleanup failed", { cause: cleanupError });
        }
      }),
    );
    stopPromise = cleanup;
    try {
      await cleanup;
      resources.release();
    } finally {
      if (stopPromise === cleanup) {
        stopPromise = undefined;
      }
    }
  };

  const stopAfterFailure = (source: string) => {
    void stop().catch((error: unknown) => {
      params.logger.warn(
        `${params.platform.logScope} ${agentLogScope} ${source} cleanup failed: ${formatErrorMessage(error)}`,
      );
    });
  };

  const writeOutputAudio = async (audio: Buffer) => {
    params.transport.beginOutput?.();
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
        if (stopped) {
          return;
        }
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
        if (stopped) {
          return;
        }
        harness.finishOutputAudio("completed");
        harness.endTurn();
      })
      .catch((error: unknown) => {
        if (stopped) {
          return;
        }
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
      consult: ({ question, responseStyle, signal }) =>
        params.consultAgent({
          meetingSessionId: params.meetingSessionId,
          requesterSessionKey: params.requesterSessionKey,
          args: { question, responseStyle },
          transcript: harness.transcript,
          abortSignal: signal,
        }),
      deliver: enqueueSpeakText,
    },
  });

  try {
    const cleanupReady = params.onCleanupReady?.(stop);
    if (cleanupReady) {
      await cleanupReady;
    }
    if (stopped) {
      throw new Error(
        `${params.platform.displayName} audio transport stopped before transcription provider setup`,
      );
    }
    params.transport.onFatal(() => {
      stopAfterFailure("audio transport");
    });
    // Both cleanup registration and onFatal can synchronously close admission.
    if (stopped) {
      throw new Error(
        `${params.platform.displayName} audio transport failed before transcription provider setup`,
      );
    }
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
      resources.run(() =>
        sttSession?.sendAudio(
          convertMeetingBridgeAudioForStt(audio, params.config.chrome.audioFormat),
        ),
      );
    });

    await sttSession.connect();
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
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new MeetingRealtimeStartupCleanupError({
        meetingSessionId: params.meetingSessionId,
        cause: error,
        cleanupError,
        stop,
      });
    }
    throw error;
  }

  return {
    providerId: resolved.provider.id,
    speak: enqueueSpeakText,
    getHealth: () => ({
      ...harness.getHealth({
        providerConnected:
          !sessionClosed && resources.run(() => sttSession?.isConnected() ?? false),
        realtimeReady,
      }),
      ...params.transport.getHealth?.(),
      bridgeClosed: stopped,
    }),
    stop,
  };
}
