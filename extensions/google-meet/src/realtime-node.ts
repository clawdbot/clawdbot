import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
} from "openclaw/plugin-sdk/realtime-transcription";
import {
  createRealtimeVoiceAgentTalkbackQueue,
  createTalkSessionController,
  createRealtimeVoiceBridgeSession,
  recordTalkObservabilityEvent,
  type RealtimeVoiceAgentTalkbackQueue,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceProviderPlugin,
  type TalkEvent,
  type TalkEventInput,
  type TalkSessionController,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  consultOpenClawAgentForGoogleMeet,
  handleGoogleMeetRealtimeConsultToolCall,
  resolveGoogleMeetRealtimeTools,
} from "./agent-consult.js";
import type { GoogleMeetConfig } from "./config.js";
import {
  getGoogleMeetRealtimeTranscriptHealth,
  buildGoogleMeetSpeakExactUserMessage,
  GOOGLE_MEET_AGENT_TRANSCRIPT_DEBOUNCE_MS,
  extendGoogleMeetOutputEchoSuppression,
  getGoogleMeetRealtimeEventHealth,
  recordGoogleMeetRealtimeTranscript,
  recordGoogleMeetRealtimeEvent,
  resolveGoogleMeetRealtimeAudioFormat,
  resolveGoogleMeetRealtimeProvider,
  resolveGoogleMeetRealtimeTranscriptionProvider,
  isGoogleMeetLikelyAssistantEchoTranscript,
  pushGoogleMeetTalkEvent,
  summarizeGoogleMeetTalkEvents,
  convertGoogleMeetBridgeAudioForStt,
  convertGoogleMeetTtsAudioForBridge,
  formatGoogleMeetAgentAudioModelLog,
  formatGoogleMeetAgentTtsResultLog,
  formatGoogleMeetTranscriptSummaryLog,
  formatGoogleMeetRealtimeVoiceModelLog,
  type GoogleMeetRealtimeEventEntry,
  type GoogleMeetRealtimeTranscriptEntry,
} from "./realtime.js";
import type { GoogleMeetChromeHealth } from "./transports/types.js";

export type ChromeNodeRealtimeAudioBridgeHandle = {
  type: "node-command-pair";
  providerId: string;
  nodeId: string;
  bridgeId: string;
  speak: (instructions?: string) => void;
  getHealth: () => GoogleMeetChromeHealth;
  stop: () => Promise<void>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeGoogleMeetTtsPromptText(text: string | undefined): string | undefined {
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

export async function startNodeAgentAudioBridge(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  meetingSessionId: string;
  requesterSessionKey?: string;
  nodeId: string;
  bridgeId: string;
  logger: RuntimeLogger;
  providers?: RealtimeTranscriptionProviderPlugin[];
}): Promise<ChromeNodeRealtimeAudioBridgeHandle> {
  let stopped = false;
  let sttSession: RealtimeTranscriptionSession | null = null;
  let realtimeReady = false;
  let lastInputAt: string | undefined;
  let lastOutputAt: string | undefined;
  let lastInputBytes = 0;
  let lastOutputBytes = 0;
  let suppressedInputBytes = 0;
  let lastSuppressedInputAt: string | undefined;
  let suppressInputUntil = 0;
  let lastOutputPlayableUntilMs = 0;
  let consecutiveInputErrors = 0;
  let lastInputError: string | undefined;
  const resolved = resolveGoogleMeetRealtimeTranscriptionProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  params.logger.info(
    formatGoogleMeetAgentAudioModelLog({
      provider: resolved.provider,
      providerConfig: resolved.providerConfig,
      audioFormat: params.config.chrome.audioFormat,
    }),
  );
  const transcript: GoogleMeetRealtimeTranscriptEntry[] = [];
  let agentTalkback: RealtimeVoiceAgentTalkbackQueue | undefined;
  let ttsQueue = Promise.resolve();

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    agentTalkback?.close();
    try {
      sttSession?.close();
    } catch (error) {
      params.logger.debug?.(
        `[google-meet] node agent transcription bridge close ignored: ${formatErrorMessage(error)}`,
      );
    }
    try {
      await params.runtime.nodes.invoke({
        nodeId: params.nodeId,
        command: "googlemeet.chrome",
        params: { action: "stop", bridgeId: params.bridgeId },
        timeoutMs: 5_000,
      });
    } catch (error) {
      params.logger.debug?.(
        `[google-meet] node audio bridge stop ignored: ${formatErrorMessage(error)}`,
      );
    }
  };

  const pushOutputAudio = async (audio: Buffer) => {
    const suppression = extendGoogleMeetOutputEchoSuppression({
      audio,
      audioFormat: params.config.chrome.audioFormat,
      nowMs: Date.now(),
      lastOutputPlayableUntilMs,
      suppressInputUntilMs: suppressInputUntil,
    });
    suppressInputUntil = suppression.suppressInputUntilMs;
    lastOutputPlayableUntilMs = suppression.lastOutputPlayableUntilMs;
    lastOutputAt = new Date().toISOString();
    lastOutputBytes += audio.byteLength;
    await params.runtime.nodes.invoke({
      nodeId: params.nodeId,
      command: "googlemeet.chrome",
      params: {
        action: "pushAudio",
        bridgeId: params.bridgeId,
        base64: Buffer.from(audio).toString("base64"),
      },
      timeoutMs: 5_000,
    });
  };

  const enqueueSpeakText = (text: string | undefined) => {
    const normalized = normalizeGoogleMeetTtsPromptText(text);
    if (!normalized || stopped) {
      return;
    }
    ttsQueue = ttsQueue
      .then(async () => {
        if (stopped) {
          return;
        }
        recordGoogleMeetRealtimeTranscript(transcript, "assistant", normalized);
        params.logger.info(
          formatGoogleMeetTranscriptSummaryLog("node agent assistant", normalized),
        );
        const result = await params.runtime.tts.textToSpeechTelephony({
          text: normalized,
          cfg: params.fullConfig,
        });
        if (!result.success || !result.audioBuffer || !result.sampleRate) {
          throw new Error(result.error ?? "TTS conversion failed");
        }
        params.logger.info(formatGoogleMeetAgentTtsResultLog("node agent", result));
        await pushOutputAudio(
          convertGoogleMeetTtsAudioForBridge(
            result.audioBuffer,
            result.sampleRate,
            params.config,
            result.outputFormat,
          ),
        );
      })
      .catch((error) => {
        params.logger.warn(`[google-meet] node agent TTS failed: ${formatErrorMessage(error)}`);
      });
  };

  agentTalkback = createRealtimeVoiceAgentTalkbackQueue({
    debounceMs: GOOGLE_MEET_AGENT_TRANSCRIPT_DEBOUNCE_MS,
    isStopped: () => stopped,
    logger: params.logger,
    logPrefix: "[google-meet] node agent",
    responseStyle: "Brief, natural spoken answer for a live meeting.",
    fallbackText: "I hit an error while checking that. Please try again.",
    consult: ({ question, responseStyle }) =>
      consultOpenClawAgentForGoogleMeet({
        config: params.config,
        fullConfig: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        meetingSessionId: params.meetingSessionId,
        requesterSessionKey: params.requesterSessionKey,
        args: { question, responseStyle },
        transcript,
      }),
    deliver: enqueueSpeakText,
  });

  sttSession = resolved.provider.createSession({
    cfg: params.fullConfig,
    providerConfig: resolved.providerConfig,
    onTranscript: (text) => {
      const trimmed = text.trim();
      if (!trimmed || stopped) {
        return;
      }
      recordGoogleMeetRealtimeTranscript(transcript, "user", trimmed);
      params.logger.info(formatGoogleMeetTranscriptSummaryLog("node agent user", trimmed));
      if (isGoogleMeetLikelyAssistantEchoTranscript({ transcript, text: trimmed })) {
        params.logger.info(
          formatGoogleMeetTranscriptSummaryLog(
            "node agent ignored assistant echo transcript",
            trimmed,
          ),
        );
        return;
      }
      agentTalkback?.enqueue(trimmed);
    },
    onError: (error) => {
      params.logger.warn(
        `[google-meet] node agent transcription bridge failed: ${formatErrorMessage(error)}`,
      );
      void stop();
    },
  });
  await sttSession.connect();
  realtimeReady = true;

  void (async () => {
    for (;;) {
      if (stopped) {
        break;
      }
      try {
        const raw = await params.runtime.nodes.invoke({
          nodeId: params.nodeId,
          command: "googlemeet.chrome",
          params: { action: "pullAudio", bridgeId: params.bridgeId, timeoutMs: 250 },
          timeoutMs: 2_000,
        });
        const result = asRecord(asRecord(raw).payload ?? raw);
        consecutiveInputErrors = 0;
        lastInputError = undefined;
        const base64 = readString(result.base64);
        if (base64) {
          const audio = Buffer.from(base64, "base64");
          if (Date.now() < suppressInputUntil) {
            lastSuppressedInputAt = new Date().toISOString();
            suppressedInputBytes += audio.byteLength;
            continue;
          }
          lastInputAt = new Date().toISOString();
          lastInputBytes += audio.byteLength;
          sttSession?.sendAudio(convertGoogleMeetBridgeAudioForStt(audio, params.config));
        }
        if (result.closed === true) {
          await stop();
        }
      } catch (error) {
        if (!stopped) {
          const message = formatErrorMessage(error);
          consecutiveInputErrors += 1;
          lastInputError = message;
          params.logger.warn(
            `[google-meet] node agent audio input failed (${consecutiveInputErrors}/5): ${message}`,
          );
          if (consecutiveInputErrors >= 5 || /unknown bridgeId|bridge is not open/i.test(message)) {
            await stop();
          } else {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      }
    }
  })();

  return {
    type: "node-command-pair",
    providerId: resolved.provider.id,
    nodeId: params.nodeId,
    bridgeId: params.bridgeId,
    speak: enqueueSpeakText,
    getHealth: () => ({
      providerConnected: sttSession?.isConnected() ?? false,
      realtimeReady,
      audioInputActive: lastInputBytes > 0,
      audioOutputActive: lastOutputBytes > 0,
      lastInputAt,
      lastOutputAt,
      lastSuppressedInputAt,
      lastInputBytes,
      lastOutputBytes,
      suppressedInputBytes,
      ...getGoogleMeetRealtimeTranscriptHealth(transcript),
      consecutiveInputErrors,
      lastInputError,
      bridgeClosed: stopped,
    }),
    stop,
  };
}

export async function startNodeRealtimeAudioBridge(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  meetingSessionId: string;
  requesterSessionKey?: string;
  nodeId: string;
  bridgeId: string;
  logger: RuntimeLogger;
  providers?: RealtimeVoiceProviderPlugin[];
}): Promise<ChromeNodeRealtimeAudioBridgeHandle> {
  let stopped = false;
  let bridge: RealtimeVoiceBridgeSession | null = null;
  let realtimeReady = false;
  let lastInputAt: string | undefined;
  let lastOutputAt: string | undefined;
  let lastClearAt: string | undefined;
  let lastInputBytes = 0;
  let lastOutputBytes = 0;
  let suppressedInputBytes = 0;
  let lastSuppressedInputAt: string | undefined;
  let suppressInputUntil = 0;
  let lastOutputPlayableUntilMs = 0;
  let consecutiveInputErrors = 0;
  let lastInputError: string | undefined;
  let clearCount = 0;
  const resolved = resolveGoogleMeetRealtimeProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  const transcript: GoogleMeetRealtimeTranscriptEntry[] = [];
  const realtimeEvents: GoogleMeetRealtimeEventEntry[] = [];
  const strategy = params.config.realtime.strategy;
  const talk: TalkSessionController = createTalkSessionController(
    {
      sessionId: `google-meet:${params.meetingSessionId}:${params.bridgeId}:node-realtime`,
      mode: "realtime",
      transport: "gateway-relay",
      brain: strategy === "bidi" ? "direct-tools" : "agent-consult",
      provider: resolved.provider.id,
    },
    { onEvent: recordTalkObservabilityEvent },
  );
  const recentTalkEvents: TalkEvent[] = [];
  const rememberTalkEvent = (event: TalkEvent | undefined): void => {
    if (event) {
      pushGoogleMeetTalkEvent(recentTalkEvents, event);
    }
  };
  const emitTalkEvent = (input: TalkEventInput): void => {
    rememberTalkEvent(talk.emit(input));
  };
  const ensureTalkTurn = (): string => {
    const turn = talk.ensureTurn({
      payload: { bridgeId: params.bridgeId, meetingSessionId: params.meetingSessionId },
    });
    if (turn.event) {
      rememberTalkEvent(turn.event);
    }
    return turn.turnId;
  };
  const finishOutputAudio = (reason: string): void => {
    rememberTalkEvent(
      talk.finishOutputAudio({
        payload: { bridgeId: params.bridgeId, reason },
      }),
    );
  };
  const endTalkTurn = (reason = "completed"): void => {
    const ended = talk.endTurn({
      payload: { bridgeId: params.bridgeId, reason },
    });
    if (ended.ok) {
      rememberTalkEvent(ended.event);
    }
  };
  emitTalkEvent({
    type: "session.started",
    payload: {
      bridgeId: params.bridgeId,
      meetingSessionId: params.meetingSessionId,
      nodeId: params.nodeId,
    },
  });
  params.logger.info(
    formatGoogleMeetRealtimeVoiceModelLog({
      strategy,
      provider: resolved.provider,
      providerConfig: resolved.providerConfig,
      fallbackModel: params.config.realtime.model,
      audioFormat: params.config.chrome.audioFormat,
    }),
  );
  let agentTalkback: RealtimeVoiceAgentTalkbackQueue | undefined;
  agentTalkback = createRealtimeVoiceAgentTalkbackQueue({
    debounceMs: GOOGLE_MEET_AGENT_TRANSCRIPT_DEBOUNCE_MS,
    isStopped: () => stopped,
    logger: params.logger,
    logPrefix: "[google-meet] node realtime agent",
    responseStyle: "Brief, natural spoken answer for a live meeting.",
    fallbackText: "I hit an error while checking that. Please try again.",
    consult: ({ question, responseStyle }) =>
      consultOpenClawAgentForGoogleMeet({
        config: params.config,
        fullConfig: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        meetingSessionId: params.meetingSessionId,
        requesterSessionKey: params.requesterSessionKey,
        args: { question, responseStyle },
        transcript,
      }),
    deliver: (text) => {
      bridge?.sendUserMessage(buildGoogleMeetSpeakExactUserMessage(text));
    },
  });

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    agentTalkback?.close();
    try {
      bridge?.close();
    } catch (error) {
      params.logger.debug?.(
        `[google-meet] node realtime bridge close ignored: ${formatErrorMessage(error)}`,
      );
    }
    try {
      await params.runtime.nodes.invoke({
        nodeId: params.nodeId,
        command: "googlemeet.chrome",
        params: { action: "stop", bridgeId: params.bridgeId },
        timeoutMs: 5_000,
      });
    } catch (error) {
      params.logger.debug?.(
        `[google-meet] node audio bridge stop ignored: ${formatErrorMessage(error)}`,
      );
    }
  };

  bridge = createRealtimeVoiceBridgeSession({
    provider: resolved.provider,
    cfg: params.fullConfig,
    providerConfig: resolved.providerConfig,
    audioFormat: resolveGoogleMeetRealtimeAudioFormat(params.config),
    instructions: params.config.realtime.instructions,
    initialGreetingInstructions: params.config.realtime.introMessage,
    autoRespondToAudio: strategy === "bidi",
    triggerGreetingOnReady: false,
    markStrategy: "ack-immediately",
    tools:
      strategy === "bidi" ? resolveGoogleMeetRealtimeTools(params.config.realtime.toolPolicy) : [],
    audioSink: {
      isOpen: () => !stopped,
      sendAudio: (audio) => {
        const turnId = ensureTalkTurn();
        rememberTalkEvent(
          talk.startOutputAudio({
            turnId,
            payload: { bridgeId: params.bridgeId },
          }).event,
        );
        emitTalkEvent({
          type: "output.audio.delta",
          turnId,
          payload: { byteLength: audio.byteLength },
        });
        const suppression = extendGoogleMeetOutputEchoSuppression({
          audio,
          audioFormat: params.config.chrome.audioFormat,
          nowMs: Date.now(),
          lastOutputPlayableUntilMs,
          suppressInputUntilMs: suppressInputUntil,
        });
        suppressInputUntil = suppression.suppressInputUntilMs;
        lastOutputPlayableUntilMs = suppression.lastOutputPlayableUntilMs;
        lastOutputAt = new Date().toISOString();
        lastOutputBytes += audio.byteLength;
        void params.runtime.nodes
          .invoke({
            nodeId: params.nodeId,
            command: "googlemeet.chrome",
            params: {
              action: "pushAudio",
              bridgeId: params.bridgeId,
              base64: Buffer.from(audio).toString("base64"),
            },
            timeoutMs: 5_000,
          })
          .catch((error) => {
            params.logger.warn(
              `[google-meet] node audio output failed: ${formatErrorMessage(error)}`,
            );
            void stop();
          });
      },
      clearAudio: () => {
        lastClearAt = new Date().toISOString();
        clearCount += 1;
        finishOutputAudio("clear");
        suppressInputUntil = 0;
        lastOutputPlayableUntilMs = 0;
        void params.runtime.nodes
          .invoke({
            nodeId: params.nodeId,
            command: "googlemeet.chrome",
            params: {
              action: "clearAudio",
              bridgeId: params.bridgeId,
            },
            timeoutMs: 5_000,
          })
          .catch((error) => {
            params.logger.warn(
              `[google-meet] node audio clear failed: ${formatErrorMessage(error)}`,
            );
            void stop();
          });
      },
    },
    onTranscript: (role, text, isFinal) => {
      const turnId = ensureTalkTurn();
      const eventType =
        role === "assistant"
          ? isFinal
            ? "output.text.done"
            : "output.text.delta"
          : isFinal
            ? "transcript.done"
            : "transcript.delta";
      const payload = role === "assistant" ? { text } : { role, text };
      emitTalkEvent({
        type: eventType,
        turnId,
        payload,
        final: isFinal,
      });
      if (role === "user" && isFinal) {
        emitTalkEvent({
          type: "input.audio.committed",
          turnId,
          payload: { bridgeId: params.bridgeId },
          final: true,
        });
      }
      if (isFinal) {
        recordGoogleMeetRealtimeTranscript(transcript, role, text);
        params.logger.info(formatGoogleMeetTranscriptSummaryLog(`node realtime ${role}`, text));
        if (role === "user" && strategy === "agent") {
          if (isGoogleMeetLikelyAssistantEchoTranscript({ transcript, text })) {
            params.logger.info(
              formatGoogleMeetTranscriptSummaryLog(
                "node realtime ignored assistant echo transcript",
                text,
              ),
            );
            return;
          }
          agentTalkback?.enqueue(text);
        }
      }
    },
    onEvent: (event) => {
      recordGoogleMeetRealtimeEvent(realtimeEvents, event);
      if (event.type === "input_audio_buffer.speech_started") {
        ensureTalkTurn();
      } else if (event.type === "input_audio_buffer.speech_stopped") {
        const turnId = talk.activeTurnId;
        if (!turnId) {
          return;
        }
        emitTalkEvent({
          type: "input.audio.committed",
          turnId,
          payload: { bridgeId: params.bridgeId, source: event.type },
          final: true,
        });
      } else if (event.type === "response.done") {
        finishOutputAudio("response.done");
        endTalkTurn("response.done");
      } else if (event.type === "error") {
        emitTalkEvent({
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
        params.logger.info(`[google-meet] node realtime ${event.direction}:${event.type}${detail}`);
      }
    },
    onToolCall: (event, session) => {
      emitTalkEvent({
        type: "tool.call",
        turnId: ensureTalkTurn(),
        itemId: event.itemId,
        callId: event.callId,
        payload: { name: event.name, args: event.args },
      });
      const turnId = ensureTalkTurn();
      handleGoogleMeetRealtimeConsultToolCall({
        strategy,
        session,
        event,
        config: params.config,
        fullConfig: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        meetingSessionId: params.meetingSessionId,
        requesterSessionKey: params.requesterSessionKey,
        transcript,
        onTalkEvent: (input) => emitTalkEvent({ ...input, turnId: input.turnId ?? turnId }),
      });
    },
    onError: (error) => {
      params.logger.warn(
        `[google-meet] node realtime voice bridge failed: ${formatErrorMessage(error)}`,
      );
      emitTalkEvent({
        type: "session.error",
        payload: { message: formatErrorMessage(error) },
        final: true,
      });
      void stop();
    },
    onClose: (reason) => {
      realtimeReady = false;
      finishOutputAudio(reason);
      emitTalkEvent({
        type: "session.closed",
        payload: { reason },
        final: true,
      });
      if (reason === "error") {
        void stop();
      }
    },
    onReady: () => {
      realtimeReady = true;
      emitTalkEvent({
        type: "session.ready",
        payload: { bridgeId: params.bridgeId },
      });
    },
  });

  await bridge.connect();

  void (async () => {
    for (;;) {
      if (stopped) {
        break;
      }
      try {
        const raw = await params.runtime.nodes.invoke({
          nodeId: params.nodeId,
          command: "googlemeet.chrome",
          params: { action: "pullAudio", bridgeId: params.bridgeId, timeoutMs: 250 },
          timeoutMs: 2_000,
        });
        const result = asRecord(asRecord(raw).payload ?? raw);
        consecutiveInputErrors = 0;
        lastInputError = undefined;
        const base64 = readString(result.base64);
        if (base64) {
          const audio = Buffer.from(base64, "base64");
          if (Date.now() < suppressInputUntil) {
            lastSuppressedInputAt = new Date().toISOString();
            suppressedInputBytes += audio.byteLength;
            continue;
          }
          lastInputAt = new Date().toISOString();
          lastInputBytes += audio.byteLength;
          emitTalkEvent({
            type: "input.audio.delta",
            turnId: ensureTalkTurn(),
            payload: { byteLength: audio.byteLength },
          });
          bridge?.sendAudio(audio);
        }
        if (result.closed === true) {
          await stop();
        }
      } catch (error) {
        if (!stopped) {
          const message = formatErrorMessage(error);
          consecutiveInputErrors += 1;
          lastInputError = message;
          params.logger.warn(
            `[google-meet] node audio input failed (${consecutiveInputErrors}/5): ${message}`,
          );
          if (consecutiveInputErrors >= 5 || /unknown bridgeId|bridge is not open/i.test(message)) {
            await stop();
          } else {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      }
    }
  })();

  return {
    type: "node-command-pair",
    providerId: resolved.provider.id,
    nodeId: params.nodeId,
    bridgeId: params.bridgeId,
    speak: (instructions) => {
      bridge?.triggerGreeting(instructions);
    },
    getHealth: () => ({
      providerConnected: bridge?.bridge.isConnected() ?? false,
      realtimeReady,
      audioInputActive: lastInputBytes > 0,
      audioOutputActive: lastOutputBytes > 0,
      lastInputAt,
      lastOutputAt,
      lastSuppressedInputAt,
      lastClearAt,
      lastInputBytes,
      lastOutputBytes,
      suppressedInputBytes,
      ...getGoogleMeetRealtimeTranscriptHealth(transcript),
      ...getGoogleMeetRealtimeEventHealth(realtimeEvents),
      recentTalkEvents: summarizeGoogleMeetTalkEvents(recentTalkEvents),
      consecutiveInputErrors,
      lastInputError,
      clearCount,
      bridgeClosed: stopped,
    }),
    stop,
  };
}
