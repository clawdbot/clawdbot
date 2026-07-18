// Shared meeting bot realtime engines own provider and audio-transport orchestration.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
} from "../plugins/types.js";
import {
  getRealtimeTranscriptionProvider,
  listRealtimeTranscriptionProviders,
} from "../realtime-transcription/provider-registry.js";
import type { RealtimeTranscriptionProviderConfig } from "../realtime-transcription/provider-types.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../talk/provider-resolver.js";
import type {
  RealtimeVoiceProviderConfig,
  RealtimeVoiceTool,
  RealtimeVoiceToolCallEvent,
} from "../talk/provider-types.js";
import {
  createRealtimeVoiceSessionHarness,
  type RealtimeVoiceSessionHarness,
} from "../talk/realtime-session-harness.js";
import type { RealtimeVoiceBridgeSession } from "../talk/session-runtime.js";
import type { TalkEventInput } from "../talk/talk-events.js";
import { truncateUtf16Safe } from "../utils.js";
import {
  resolveMeetingRealtimeAudioFormat,
  type MeetingRealtimeAudioFormat,
} from "./realtime-audio-format.js";
import type {
  MeetingRealtimeAudioTransport,
  MeetingRealtimeAudioTransportHealth,
} from "./realtime-audio-transport.js";

export type MeetingRuntimePlatform = {
  /** Adapter-owned identity keeps platform names and log prefixes out of core. */
  displayName: string;
  logScope: string;
  sessionIdPrefix: string;
};

export type MeetingRealtimeEngineConfig = {
  chrome: { audioFormat: MeetingRealtimeAudioFormat };
  realtime: {
    strategy: string;
    provider?: string;
    transcriptionProvider?: string;
    voiceProvider?: string;
    model?: string;
    instructions?: string;
    introMessage?: string;
    providers: Record<string, Record<string, unknown>>;
  };
};

export type MeetingAgentConsultParams = {
  meetingSessionId: string;
  requesterSessionKey?: string;
  args: unknown;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
};

export type MeetingRealtimeToolCallParams = {
  strategy: string;
  session: RealtimeVoiceBridgeSession;
  event: RealtimeVoiceToolCallEvent;
  meetingSessionId: string;
  requesterSessionKey?: string;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  onTalkEvent: (event: TalkEventInput) => void;
};

export type MeetingRealtimeAudioEngineHealth = ReturnType<
  RealtimeVoiceSessionHarness["getHealth"]
> &
  MeetingRealtimeAudioTransportHealth & {
    lastClearAt?: string;
    clearCount?: number;
    bridgeClosed: boolean;
  };

export type MeetingRealtimeAudioEngineHandle = {
  providerId: string;
  speak: (instructions?: string) => void;
  getHealth: () => MeetingRealtimeAudioEngineHealth;
  stop: () => Promise<void>;
};

type ResolvedRealtimeProvider = {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
};

type ResolvedRealtimeTranscriptionProvider = {
  provider: RealtimeTranscriptionProviderPlugin;
  providerConfig: RealtimeTranscriptionProviderConfig;
};

export const MEETING_AGENT_TRANSCRIPT_DEBOUNCE_MS = 900;
// Playback duration plus a tail blocks live loopback; transcript lookback catches delayed echo.
export const MEETING_OUTPUT_ECHO_SUPPRESSION_TAIL_MS = 3_000;
export const MEETING_TRANSCRIPT_ECHO_LOOKBACK_MS = 45_000;

export function meetingOutputBytesPerMs(audioFormat: MeetingRealtimeAudioFormat): number {
  return audioFormat === "g711-ulaw-8khz" ? 8 : 48;
}

function resolveMeetingRealtimeProvider(params: {
  config: MeetingRealtimeEngineConfig;
  fullConfig: OpenClawConfig;
  providers?: RealtimeVoiceProviderPlugin[];
}): ResolvedRealtimeProvider {
  const providerId = params.config.realtime.voiceProvider ?? params.config.realtime.provider;
  return resolveConfiguredRealtimeVoiceProvider({
    configuredProviderId: providerId,
    providerConfigs: params.config.realtime.providers,
    cfg: params.fullConfig,
    providers: params.providers,
    defaultModel: params.config.realtime.model,
    noRegisteredProviderMessage: "No configured realtime voice provider registered",
  });
}

export function resolveMeetingRealtimeTranscriptionProvider(params: {
  config: MeetingRealtimeEngineConfig;
  fullConfig: OpenClawConfig;
  providers?: RealtimeTranscriptionProviderPlugin[];
}): ResolvedRealtimeTranscriptionProvider {
  const providers = params.providers ?? listRealtimeTranscriptionProviders(params.fullConfig);
  if (providers.length === 0) {
    throw new Error("No configured realtime transcription provider registered");
  }
  const providerId =
    params.config.realtime.transcriptionProvider ?? params.config.realtime.provider;
  const configuredProvider = providerId
    ? (params.providers?.find(
        (entry) => entry.id === providerId || entry.aliases?.includes(providerId),
      ) ?? getRealtimeTranscriptionProvider(providerId, params.fullConfig))
    : undefined;
  const provider = configuredProvider ?? providers[0];
  if (!provider) {
    throw new Error("No configured realtime transcription provider registered");
  }
  const rawConfig = providerId
    ? (params.config.realtime.providers[providerId] ??
      params.config.realtime.providers[provider.id] ??
      {})
    : (params.config.realtime.providers[provider.id] ?? {});
  const providerConfig = provider.resolveConfig
    ? provider.resolveConfig({ cfg: params.fullConfig, rawConfig })
    : rawConfig;
  if (!provider.isConfigured({ cfg: params.fullConfig, providerConfig })) {
    throw new Error(`Realtime transcription provider "${provider.id}" is not configured`);
  }
  return { provider, providerConfig };
}

function buildMeetingSpeakExactUserMessage(text: string): string {
  return [
    "Speak this exact OpenClaw answer to the meeting, without adding, removing, or rephrasing words.",
    `Answer: ${JSON.stringify(text)}`,
  ].join("\n");
}

function readLogString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatLogValue(value: string | undefined): string {
  const normalized = value ? truncateUtf16Safe(value.replace(/\s+/g, "_"), 180) : undefined;
  return normalized || "unknown";
}

function resolveProviderModelForLog(params: {
  provider: { defaultModel?: string };
  providerConfig: RealtimeVoiceProviderConfig | RealtimeTranscriptionProviderConfig;
  fallbackModel?: string;
}): string {
  return (
    readLogString(params.providerConfig.model) ??
    readLogString(params.providerConfig.modelId) ??
    readLogString(params.fallbackModel) ??
    readLogString(params.provider.defaultModel) ??
    "provider-default"
  );
}

function formatMeetingRealtimeVoiceModelLog(params: {
  logScope: string;
  strategy: string;
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  fallbackModel?: string;
  audioFormat: MeetingRealtimeAudioFormat;
}): string {
  return [
    `${params.logScope} realtime voice bridge starting: strategy=${formatLogValue(params.strategy)}`,
    `provider=${formatLogValue(params.provider.id)}`,
    `model=${formatLogValue(
      resolveProviderModelForLog({
        provider: params.provider,
        providerConfig: params.providerConfig,
        fallbackModel: params.fallbackModel,
      }),
    )}`,
    `audioFormat=${formatLogValue(params.audioFormat)}`,
  ].join(" ");
}

export function formatMeetingAgentAudioModelLog(params: {
  logScope: string;
  provider: RealtimeTranscriptionProviderPlugin;
  providerConfig: RealtimeTranscriptionProviderConfig;
  audioFormat: MeetingRealtimeAudioFormat;
}): string {
  return [
    `${params.logScope} agent audio bridge starting: transcriptionProvider=${formatLogValue(
      params.provider.id,
    )}`,
    `transcriptionModel=${formatLogValue(
      resolveProviderModelForLog({
        provider: params.provider,
        providerConfig: params.providerConfig,
      }),
    )}`,
    "tts=telephony",
    `audioFormat=${formatLogValue(params.audioFormat)}`,
  ].join(" ");
}

type MeetingTtsResultLogFields = {
  provider?: string;
  providerModel?: string;
  providerVoice?: string;
  outputFormat?: string;
  sampleRate?: number;
  fallbackFrom?: string;
};

export function formatMeetingAgentTtsResultLog(
  logScope: string,
  prefix: string,
  result: MeetingTtsResultLogFields,
): string {
  return [
    `${logScope} ${prefix} TTS: provider=${formatLogValue(result.provider)}`,
    `model=${formatLogValue(result.providerModel)}`,
    `voice=${formatLogValue(result.providerVoice)}`,
    `outputFormat=${formatLogValue(result.outputFormat)}`,
    `sampleRate=${result.sampleRate ?? "unknown"}`,
    ...(result.fallbackFrom ? [`fallbackFrom=${formatLogValue(result.fallbackFrom)}`] : []),
  ].join(" ");
}

export function formatMeetingTranscriptSummaryLog(
  logScope: string,
  prefix: string,
  text: string,
): string {
  return `${logScope} ${prefix}: chars=${text.length}`;
}

export function normalizeMeetingTtsPromptText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sayExactly = trimmed.match(/^say exactly:\s*(?<text>.+)$/is)?.groups?.text?.trim();
  if (sayExactly) {
    return sayExactly.replace(/^["']|["']$/g, "").trim() || trimmed;
  }
  return trimmed;
}

export async function startMeetingRealtimeEngine(params: {
  config: MeetingRealtimeEngineConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  platform: MeetingRuntimePlatform;
  meetingSessionId: string;
  requesterSessionKey?: string;
  logPrefix?: "node";
  talkSessionId?: string;
  talkContext?: { nodeId: string; bridgeId: string };
  transport: MeetingRealtimeAudioTransport;
  logger: RuntimeLogger;
  providers?: RealtimeVoiceProviderPlugin[];
  consultAgent: (params: MeetingAgentConsultParams) => Promise<{ text: string }>;
  tools: RealtimeVoiceTool[];
  handleToolCall: (params: MeetingRealtimeToolCallParams) => Promise<void>;
}): Promise<MeetingRealtimeAudioEngineHandle> {
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  let bridgeClosed = false;
  let transportStopped = false;
  let transportDisposed = false;
  // Not const: the synchronous onFatal replay can run stop() (and its bridge?.close())
  // before createBridge() below executes; a later `const` would throw at that read.
  let bridge: RealtimeVoiceBridgeSession | undefined = undefined;
  let realtimeReady = false;
  let lastClearAt: string | undefined;
  let clearCount = 0;
  const realtimeLogScope = params.logPrefix ? `${params.logPrefix} realtime` : "realtime";

  const stop = async () => {
    stopped = true;
    if (stopPromise) {
      await stopPromise;
      return;
    }
    const cleanup = Promise.resolve().then(async () => {
      if (!bridgeClosed) {
        bridgeClosed = true;
        harness.close();
        try {
          bridge?.close();
        } catch (error) {
          params.logger.debug?.(
            `${params.platform.logScope} ${realtimeLogScope}${params.logPrefix ? "" : " voice"} bridge close ignored: ${formatErrorMessage(error)}`,
          );
        }
      }
      let cleanupError: unknown;
      if (!transportStopped) {
        try {
          await params.transport.stop();
          transportStopped = true;
        } catch (error) {
          cleanupError = error;
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
      if (cleanupError) {
        throw cleanupError instanceof Error
          ? cleanupError
          : new Error("Meeting realtime transport cleanup failed", { cause: cleanupError });
      }
    });
    stopPromise = cleanup;
    try {
      await cleanup;
    } finally {
      if (stopPromise === cleanup) {
        stopPromise = undefined;
      }
    }
  };
  const stopAfterFailure = (source: string) => {
    void stop().catch((error: unknown) => {
      params.logger.warn(
        `${params.platform.logScope} ${realtimeLogScope} ${source} cleanup failed: ${formatErrorMessage(error)}`,
      );
    });
  };
  const clearOutputPlayback = () => {
    if (stopped) {
      return;
    }
    clearCount += 1;
    lastClearAt = new Date().toISOString();
    void params.transport.clearOutput().catch((error: unknown) => {
      params.logger.warn(
        `${params.platform.logScope} ${params.logPrefix ? `${params.logPrefix} audio clear` : "audio output clear"} failed: ${formatErrorMessage(error)}`,
      );
      stopAfterFailure("audio output clear");
    });
  };
  const writeOutputAudio = (audio: Buffer) => {
    void params.transport.writeOutput(audio).catch((error: unknown) => {
      params.logger.warn(
        `${params.platform.logScope} ${params.logPrefix ? `${params.logPrefix} audio output` : "audio output"} failed: ${formatErrorMessage(error)}`,
      );
      stopAfterFailure("audio output");
    });
  };
  const startHumanBargeInMonitor = () => {
    if (!params.transport.startBargeInMonitor) {
      return;
    }
    params.transport.startBargeInMonitor(() => {
      if (stopped || !harness.outputActivity.isInterruptible()) {
        return false;
      }
      const now = Date.now();
      const playbackActive = harness.isOutputPlaybackWindowActive();
      const lastOutputAudioAt = harness.outputActivity.snapshot().lastAudioAt;
      if (!playbackActive && (lastOutputAudioAt === undefined || now - lastOutputAudioAt > 1_000)) {
        return false;
      }
      harness.handleBargeIn({ audioPlaybackActive: true }, clearOutputPlayback);
      return true;
    });
  };

  const resolved = resolveMeetingRealtimeProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  const strategy = params.config.realtime.strategy;
  params.logger.info(
    formatMeetingRealtimeVoiceModelLog({
      logScope: params.platform.logScope,
      strategy,
      provider: resolved.provider,
      providerConfig: resolved.providerConfig,
      fallbackModel: params.config.realtime.model,
      audioFormat: params.config.chrome.audioFormat,
    }),
  );
  const meetingTalkPayload = params.talkContext
    ? { bridgeId: params.talkContext.bridgeId, meetingSessionId: params.meetingSessionId }
    : { meetingSessionId: params.meetingSessionId };
  const outputTalkPayload = params.talkContext
    ? { bridgeId: params.talkContext.bridgeId }
    : { meetingSessionId: params.meetingSessionId };
  const reasonTalkPayload = (reason: string) =>
    params.talkContext ? { bridgeId: params.talkContext.bridgeId, reason } : { reason };
  // The closures above only run after harness creation; they capture this later `const`.
  // Annotated because the consult closure references harness inside its own initializer.
  const harness: RealtimeVoiceSessionHarness = createRealtimeVoiceSessionHarness({
    talk: {
      sessionId:
        params.talkSessionId ??
        `${params.platform.sessionIdPrefix}:${params.meetingSessionId}:command-realtime`,
      mode: "realtime",
      transport: "gateway-relay",
      brain: strategy === "bidi" ? "direct-tools" : "agent-consult",
      provider: resolved.provider.id,
    },
    talkPayloads: {
      turnStarted: () => meetingTalkPayload,
      turnEnded: reasonTalkPayload,
      inputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
      outputAudioStarted: () => outputTalkPayload,
      outputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
      outputAudioDone: reasonTalkPayload,
    },
    echoSuppression: {
      bytesPerMs: meetingOutputBytesPerMs(params.config.chrome.audioFormat),
      tailMs: MEETING_OUTPUT_ECHO_SUPPRESSION_TAIL_MS,
      transcriptLookbackMs: MEETING_TRANSCRIPT_ECHO_LOOKBACK_MS,
    },
    talkback: {
      debounceMs: MEETING_AGENT_TRANSCRIPT_DEBOUNCE_MS,
      logger: params.logger,
      logPrefix: `${params.platform.logScope} ${realtimeLogScope} agent`,
      responseStyle: "Brief, natural spoken answer for a live meeting.",
      fallbackText: "I hit an error while checking that. Please try again.",
      consult: ({ question, responseStyle }) =>
        params.consultAgent({
          meetingSessionId: params.meetingSessionId,
          requesterSessionKey: params.requesterSessionKey,
          args: { question, responseStyle },
          transcript: harness.transcript,
        }),
      deliver: (text) => {
        bridge?.sendUserMessage(buildMeetingSpeakExactUserMessage(text));
      },
    },
  });
  harness.emit({
    type: "session.started",
    payload: params.talkContext
      ? { ...meetingTalkPayload, nodeId: params.talkContext.nodeId }
      : meetingTalkPayload,
  });
  params.transport.onFatal(() => {
    stopAfterFailure("audio transport");
  });
  // onFatal replays a pre-registration failure synchronously; abort before creating a
  // voice bridge that the already-completed stop() could never close.
  if (stopped) {
    throw new Error(
      `${params.platform.displayName} audio transport failed before realtime provider setup`,
    );
  }
  try {
    bridge = harness.createBridge({
      provider: resolved.provider,
      cfg: params.fullConfig,
      providerConfig: resolved.providerConfig,
      audioFormat: resolveMeetingRealtimeAudioFormat(params.config.chrome.audioFormat),
      instructions: params.config.realtime.instructions,
      initialGreetingInstructions: params.config.realtime.introMessage,
      autoRespondToAudio: strategy === "bidi",
      triggerGreetingOnReady: false,
      markStrategy: "ack-immediately",
      tools: strategy === "bidi" ? params.tools : [],
      audioSink: {
        isOpen: () => !stopped,
        sendAudio: (audio) => {
          harness.outputActivity.markPlaybackStarted();
          harness.recordOutputAudio(audio);
          writeOutputAudio(audio);
        },
        clearAudio: () => {
          harness.flushOutput(clearOutputPlayback);
          harness.finishOutputAudio("clear");
        },
      },
      onTranscript: (role, text, isFinal) => {
        const turnId = harness.ensureTurn();
        const eventType =
          role === "assistant"
            ? isFinal
              ? "output.text.done"
              : "output.text.delta"
            : isFinal
              ? "transcript.done"
              : "transcript.delta";
        const payload = role === "assistant" ? { text } : { role, text };
        harness.emit({
          type: eventType,
          turnId,
          payload,
          final: isFinal,
        });
        if (role === "user" && isFinal) {
          harness.emit({
            type: "input.audio.committed",
            turnId,
            payload: outputTalkPayload,
            final: true,
          });
        }
        if (isFinal) {
          params.logger.info(
            formatMeetingTranscriptSummaryLog(
              params.platform.logScope,
              `${realtimeLogScope} ${role}`,
              text,
            ),
          );
          if (role === "user" && strategy === "agent") {
            if (harness.isLikelyAssistantEchoTranscript(text)) {
              params.logger.info(
                formatMeetingTranscriptSummaryLog(
                  params.platform.logScope,
                  `${realtimeLogScope} ignored assistant echo transcript`,
                  text,
                ),
              );
              return;
            }
            harness.talkback?.enqueue(text);
          }
        }
      },
      onEvent: (event) => {
        if (event.type === "input_audio_buffer.speech_started") {
          harness.ensureTurn();
        } else if (event.type === "input_audio_buffer.speech_stopped") {
          const turnId = harness.talk.activeTurnId;
          if (!turnId) {
            return;
          }
          harness.emit({
            type: "input.audio.committed",
            turnId,
            payload: { ...outputTalkPayload, source: event.type },
            final: true,
          });
        } else if (event.type === "response.done") {
          harness.finishOutputAudio("response.done");
          harness.endTurn("response.done");
        } else if (event.type === "error") {
          harness.emit({
            type: "session.error",
            payload: { message: event.detail ?? "Realtime provider error" },
            final: true,
          });
        }
        if (
          event.type === "error" ||
          event.type === "response.done" ||
          event.type === "input_audio_buffer.speech_started" ||
          event.type === "input_audio_buffer.speech_stopped" ||
          event.type === "conversation.item.input_audio_transcription.completed" ||
          event.type === "conversation.item.input_audio_transcription.failed"
        ) {
          const detail = event.detail ? ` ${event.detail}` : "";
          params.logger.info(
            `${params.platform.logScope} ${realtimeLogScope} ${event.direction}:${event.type}${detail}`,
          );
        }
      },
      onToolCall: (event, session) => {
        harness.emit({
          type: "tool.call",
          turnId: harness.ensureTurn(),
          itemId: event.itemId,
          callId: event.callId,
          payload: { name: event.name, args: event.args },
        });
        const turnId = harness.ensureTurn();
        return params.handleToolCall({
          strategy,
          session,
          event,
          meetingSessionId: params.meetingSessionId,
          requesterSessionKey: params.requesterSessionKey,
          transcript: harness.transcript,
          onTalkEvent: (inputLocal) =>
            harness.emit({ ...inputLocal, turnId: inputLocal.turnId ?? turnId }),
        });
      },
      onError: (error) => {
        harness.emit({
          type: "session.error",
          payload: { message: formatErrorMessage(error) },
          final: true,
        });
        params.logger.warn(
          `${params.platform.logScope} ${realtimeLogScope} voice bridge failed: ${formatErrorMessage(error)}`,
        );
        stopAfterFailure("voice bridge");
      },
      onClose: (reason) => {
        realtimeReady = false;
        harness.finishOutputAudio(reason);
        harness.emit({
          type: "session.closed",
          payload: { reason },
          final: true,
        });
        stopAfterFailure("voice bridge close");
      },
      onReady: () => {
        realtimeReady = true;
        harness.emit({
          type: "session.ready",
          payload: outputTalkPayload,
        });
      },
    });
    startHumanBargeInMonitor();

    // Drain transport input while connect() is pending so the capture pipe never backpressures.
    // Pre-connect audio is forwarded; the voice bridge owns buffering, matching the previous
    // local command-pair behavior.
    params.transport.startInput((audio) => {
      if (stopped || audio.byteLength === 0) {
        return;
      }
      if (!harness.recordInputAudio(audio)) {
        return;
      }
      bridge?.sendAudio(audio);
    });

    await bridge.connect();
    if (stopped) {
      throw new Error(
        `${params.platform.displayName} audio transport stopped during realtime provider setup`,
      );
    }
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      params.logger.debug?.(
        `${params.platform.logScope} ${realtimeLogScope} failed-start cleanup ignored: ${formatErrorMessage(cleanupError)}`,
      );
      try {
        await stop();
      } catch (retryError) {
        params.logger.debug?.(
          `${params.platform.logScope} ${realtimeLogScope} failed-start cleanup retry ignored: ${formatErrorMessage(retryError)}`,
        );
      }
    }
    throw error;
  }

  return {
    providerId: resolved.provider.id,
    speak: (instructions) => {
      bridge?.triggerGreeting(instructions);
    },
    getHealth: () => ({
      ...harness.getHealth({
        providerConnected: bridge?.bridge.isConnected() ?? false,
        realtimeReady,
      }),
      ...params.transport.getHealth?.(),
      lastClearAt,
      clearCount,
      bridgeClosed: stopped,
    }),
    stop,
  };
}
