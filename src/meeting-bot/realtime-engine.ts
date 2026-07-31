// Shared meeting bot realtime engines own provider and audio-transport orchestration.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { RealtimeVoiceTool, RealtimeVoiceToolCallEvent } from "../talk/provider-types.js";
import {
  createRealtimeVoiceSessionHarness,
  type RealtimeVoiceSessionHarness,
} from "../talk/realtime-session-harness.js";
import type { RealtimeVoiceBridgeSession } from "../talk/session-runtime.js";
import type { TalkEventInput } from "../talk/talk-events.js";
import {
  resolveMeetingRealtimeAudioFormat,
  type MeetingRealtimeAudioFormat,
} from "./realtime-audio-format.js";
import type {
  MeetingRealtimeAudioTransport,
  MeetingRealtimeAudioTransportHealth,
} from "./realtime-audio-transport.js";
import {
  buildMeetingSpeakExactUserMessage,
  formatMeetingTranscriptSummaryLog,
  formatMeetingRealtimeVoiceModelLog,
  meetingOutputBytesPerMs,
  resolveMeetingRealtimeProvider,
} from "./realtime-engine-support.js";
import { createMeetingRealtimeOutputOwner } from "./realtime-output-owner.js";

export {
  formatMeetingAgentAudioModelLog,
  formatMeetingAgentTtsResultLog,
  formatMeetingTranscriptSummaryLog,
  meetingOutputBytesPerMs,
  normalizeMeetingTtsPromptText,
  resolveMeetingRealtimeTranscriptionProvider,
} from "./realtime-engine-support.js";

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

export const MEETING_AGENT_TRANSCRIPT_DEBOUNCE_MS = 900;
// Playback duration plus a tail blocks live loopback; transcript lookback catches delayed echo.
export const MEETING_OUTPUT_ECHO_SUPPRESSION_TAIL_MS = 3_000;
export const MEETING_TRANSCRIPT_ECHO_LOOKBACK_MS = 45_000;
const MEETING_REALTIME_OUTPUT_MAX_PENDING_MS = 2_000;
const MEETING_REALTIME_OUTPUT_MAX_WRITE_MS = 500;
const MEETING_REALTIME_OUTPUT_MAX_PENDING_FRAMES = 256;
const MEETING_REALTIME_CANCELLATION_RACE_DETAIL = "Cancellation failed: no active response found";

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
  let outputGeneration = 0;
  let outputWriteActive = false;
  let outputTransportWriteStarted = false;
  let outputClearPending = 0;
  let outputClearAfterActive = false;
  let outputPendingBytes = 0;
  let outputPendingFrames = 0;
  let outputGenerationActive = false;
  let outputClearTail = Promise.resolve();
  const outputQueue: Array<{ audio: Buffer; generation: number }> = [];
  const outputOwner = createMeetingRealtimeOutputOwner();
  const outputMaxPendingBytes =
    meetingOutputBytesPerMs(params.config.chrome.audioFormat) *
    MEETING_REALTIME_OUTPUT_MAX_PENDING_MS;
  const outputMaxWriteBytes =
    meetingOutputBytesPerMs(params.config.chrome.audioFormat) *
    MEETING_REALTIME_OUTPUT_MAX_WRITE_MS;
  const realtimeLogScope = params.logPrefix ? `${params.logPrefix} realtime` : "realtime";

  const invalidateOutputQueue = () => {
    outputGeneration += 1;
    outputQueue.length = 0;
    outputPendingBytes = 0;
    outputPendingFrames = 0;
    outputGenerationActive = false;
  };

  const stop = async () => {
    if (!stopped) {
      stopped = true;
      outputOwner.reset();
      outputClearAfterActive = false;
      invalidateOutputQueue();
    }
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
  const queueOutputClear = (): Promise<void> => {
    if (stopped) {
      return Promise.resolve();
    }
    clearCount += 1;
    lastClearAt = new Date().toISOString();
    outputClearPending += 1;
    const clear = outputClearTail
      .then(async () => {
        if (!stopped) {
          await params.transport.clearOutput();
        }
      })
      .catch((error: unknown) => {
        params.logger.warn(
          `${params.platform.logScope} ${params.logPrefix ? `${params.logPrefix} audio clear` : "audio output clear"} failed: ${formatErrorMessage(error)}`,
        );
        stopAfterFailure("audio output clear");
      })
      .finally(() => {
        outputClearPending -= 1;
        pumpOutputQueue();
      });
    outputClearTail = clear;
    return clear;
  };

  const pumpOutputQueue = () => {
    if (stopped || outputWriteActive || outputClearPending > 0) {
      return;
    }
    const next = outputQueue.shift();
    if (!next) {
      return;
    }
    if (next.generation !== outputGeneration) {
      pumpOutputQueue();
      return;
    }
    const batch = [next.audio];
    let batchBytes = next.audio.byteLength;
    let batchFrames = 1;
    while (batchBytes < outputMaxWriteBytes) {
      const queued = outputQueue[0];
      if (
        !queued ||
        queued.generation !== next.generation ||
        queued.audio.byteLength > outputMaxWriteBytes - batchBytes
      ) {
        break;
      }
      outputQueue.shift();
      batch.push(queued.audio);
      batchBytes += queued.audio.byteLength;
      batchFrames += 1;
    }
    const audio = batch.length === 1 ? next.audio : Buffer.concat(batch, batchBytes);
    outputWriteActive = true;
    void Promise.resolve()
      .then(async () => {
        if (stopped || next.generation !== outputGeneration) {
          return;
        }
        outputTransportWriteStarted = true;
        await params.transport.writeOutput(audio);
      })
      .catch((error: unknown) => {
        if (stopped || next.generation !== outputGeneration) {
          return;
        }
        params.logger.warn(
          `${params.platform.logScope} ${params.logPrefix ? `${params.logPrefix} audio output` : "audio output"} failed: ${formatErrorMessage(error)}`,
        );
        stopAfterFailure("audio output");
      })
      .finally(() => {
        outputWriteActive = false;
        outputTransportWriteStarted = false;
        if (next.generation === outputGeneration) {
          outputPendingBytes -= batchBytes;
          outputPendingFrames -= batchFrames;
        }
        if (outputClearAfterActive && !stopped) {
          outputClearAfterActive = false;
          void queueOutputClear();
          return;
        }
        pumpOutputQueue();
      });
  };
  const clearOutputPlayback = (): void => {
    void queueOutputClear();
  };
  const invalidateOutputPlayback = (): void => {
    outputClearAfterActive ||= outputTransportWriteStarted;
    invalidateOutputQueue();
  };
  const invalidateAndClearOutputPlayback = (): void => {
    blockOutput();
    clearOutputPlayback();
  };

  const blockOutput = (): { blocked: boolean; token: symbol } => {
    const result = outputOwner.block();
    invalidateOutputPlayback();
    return result;
  };

  const handleOutputBackpressure = () => {
    const pendingBytes = outputPendingBytes;
    const pendingFrames = outputPendingFrames;
    const { blocked, token } = blockOutput();
    if (!blocked) {
      return;
    }
    params.logger.warn(
      `${params.platform.logScope} ${realtimeLogScope} audio output backpressured: pendingBytes=${pendingBytes} pendingFrames=${pendingFrames}`,
    );
    harness.flushOutput(clearOutputPlayback);
    harness.finishOutputAudio("output-backpressure");
    queueMicrotask(() => {
      if (stopped || !outputOwner.isBlockedBy(token)) {
        return;
      }
      harness.handleBargeIn({ audioPlaybackActive: true, force: true }, () => {});
    });
  };

  const queueOutputAudio = (audio: Buffer, responseId: string | undefined): boolean => {
    if (stopped || !outputOwner.accept(responseId)) {
      return false;
    }
    if (
      audio.byteLength > outputMaxPendingBytes - outputPendingBytes ||
      outputPendingFrames >= MEETING_REALTIME_OUTPUT_MAX_PENDING_FRAMES
    ) {
      handleOutputBackpressure();
      return false;
    }
    outputPendingBytes += audio.byteLength;
    outputPendingFrames += 1;
    outputQueue.push({ audio, generation: outputGeneration });
    pumpOutputQueue();
    return true;
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
      harness.handleBargeIn({ audioPlaybackActive: true }, invalidateAndClearOutputPlayback);
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
          const responseId = outputOwner.takeNextResponseId();
          if (!queueOutputAudio(audio, responseId)) {
            return;
          }
          if (!outputGenerationActive) {
            params.transport.beginOutput?.();
            outputGenerationActive = true;
          }
          harness.outputActivity.markPlaybackStarted();
          harness.recordOutputAudio(audio);
        },
        clearAudio: () => {
          if (outputOwner.providerClear()) {
            invalidateOutputPlayback();
            harness.flushOutput(clearOutputPlayback);
            harness.finishOutputAudio("clear");
          }
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
          }
          if (role === "user" && strategy === "agent") {
            harness.talkback?.enqueue(text);
          }
        }
      },
      onEvent: (event) => {
        outputOwner.noteEvent(event);
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
        } else if (event.type === "response.done" || event.type === "response.cancelled") {
          if (outputOwner.terminal(event.responseId)) {
            outputGenerationActive = false;
            harness.finishOutputAudio(event.type);
            if (event.type === "response.done") {
              harness.endTurn(event.type);
            }
          }
        } else if (
          event.type === "error" &&
          event.detail === MEETING_REALTIME_CANCELLATION_RACE_DETAIL
        ) {
          if (outputOwner.clearBlocked()) {
            outputGenerationActive = false;
            harness.finishOutputAudio(event.type);
          }
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
        outputGenerationActive = false;
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
