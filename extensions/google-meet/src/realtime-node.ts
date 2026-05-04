import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
} from "openclaw/plugin-sdk/realtime-transcription";
import {
  createRealtimeVoiceBridgeSession,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  consultOpenClawAgentForGoogleMeet,
  GOOGLE_MEET_AGENT_CONSULT_TOOL_NAME,
  resolveGoogleMeetRealtimeTools,
  submitGoogleMeetConsultWorkingResponse,
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
  convertGoogleMeetBridgeAudioForStt,
  convertGoogleMeetTtsAudioForBridge,
  formatGoogleMeetAgentAudioModelLog,
  formatGoogleMeetAgentTtsResultLog,
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
  let agentConsultActive = false;
  let pendingAgentQuestion: string | undefined;
  let agentConsultDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let ttsQueue = Promise.resolve();

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (agentConsultDebounceTimer) {
      clearTimeout(agentConsultDebounceTimer);
      agentConsultDebounceTimer = undefined;
    }
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
        params.logger.info(`[google-meet] node agent assistant: ${normalized}`);
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

  const runAgentConsultForUserTranscript = async (question: string): Promise<void> => {
    const trimmed = question.trim();
    if (!trimmed || stopped) {
      return;
    }
    if (agentConsultActive) {
      pendingAgentQuestion = trimmed;
      return;
    }
    agentConsultActive = true;
    let nextQuestion: string | undefined = trimmed;
    try {
      while (nextQuestion) {
        if (stopped) {
          return;
        }
        const currentQuestion = nextQuestion;
        pendingAgentQuestion = undefined;
        params.logger.info(`[google-meet] node agent consult: ${currentQuestion}`);
        const result = await consultOpenClawAgentForGoogleMeet({
          config: params.config,
          fullConfig: params.fullConfig,
          runtime: params.runtime,
          logger: params.logger,
          meetingSessionId: params.meetingSessionId,
          requesterSessionKey: params.requesterSessionKey,
          args: {
            question: currentQuestion,
            responseStyle: "Brief, natural spoken answer for a live meeting.",
          },
          transcript,
        });
        enqueueSpeakText(result.text);
        nextQuestion = pendingAgentQuestion;
      }
    } catch (error) {
      params.logger.warn(`[google-meet] node agent consult failed: ${formatErrorMessage(error)}`);
      enqueueSpeakText("I hit an error while checking that. Please try again.");
    } finally {
      agentConsultActive = false;
      const queuedQuestion = pendingAgentQuestion;
      pendingAgentQuestion = undefined;
      if (queuedQuestion && !stopped) {
        void runAgentConsultForUserTranscript(queuedQuestion);
      }
    }
  };

  const enqueueAgentConsultForUserTranscript = (question: string): void => {
    const trimmed = question.trim();
    if (!trimmed || stopped) {
      return;
    }
    pendingAgentQuestion = pendingAgentQuestion ? `${pendingAgentQuestion}\n${trimmed}` : trimmed;
    if (agentConsultDebounceTimer) {
      clearTimeout(agentConsultDebounceTimer);
    }
    agentConsultDebounceTimer = setTimeout(() => {
      agentConsultDebounceTimer = undefined;
      const queuedQuestion = pendingAgentQuestion;
      pendingAgentQuestion = undefined;
      if (queuedQuestion && !stopped) {
        void runAgentConsultForUserTranscript(queuedQuestion);
      }
    }, GOOGLE_MEET_AGENT_TRANSCRIPT_DEBOUNCE_MS);
    agentConsultDebounceTimer.unref?.();
  };

  sttSession = resolved.provider.createSession({
    providerConfig: resolved.providerConfig,
    onTranscript: (text) => {
      const trimmed = text.trim();
      if (!trimmed || stopped) {
        return;
      }
      recordGoogleMeetRealtimeTranscript(transcript, "user", trimmed);
      params.logger.info(`[google-meet] node agent user: ${trimmed}`);
      if (isGoogleMeetLikelyAssistantEchoTranscript({ transcript, text: trimmed })) {
        params.logger.info(
          `[google-meet] node agent ignored assistant echo transcript: ${trimmed}`,
        );
        return;
      }
      enqueueAgentConsultForUserTranscript(trimmed);
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
  params.logger.info(
    formatGoogleMeetRealtimeVoiceModelLog({
      strategy,
      provider: resolved.provider,
      providerConfig: resolved.providerConfig,
      fallbackModel: params.config.realtime.model,
      audioFormat: params.config.chrome.audioFormat,
    }),
  );
  let agentConsultActive = false;
  let pendingAgentQuestion: string | undefined;
  let agentConsultDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  const enqueueAgentConsultForUserTranscript = (question: string): void => {
    const trimmed = question.trim();
    if (!trimmed || stopped) {
      return;
    }
    pendingAgentQuestion = pendingAgentQuestion ? `${pendingAgentQuestion}\n${trimmed}` : trimmed;
    if (agentConsultDebounceTimer) {
      clearTimeout(agentConsultDebounceTimer);
    }
    agentConsultDebounceTimer = setTimeout(() => {
      agentConsultDebounceTimer = undefined;
      const queuedQuestion = pendingAgentQuestion;
      pendingAgentQuestion = undefined;
      if (queuedQuestion && !stopped) {
        void runAgentConsultForUserTranscript(queuedQuestion);
      }
    }, GOOGLE_MEET_AGENT_TRANSCRIPT_DEBOUNCE_MS);
    agentConsultDebounceTimer.unref?.();
  };
  const runAgentConsultForUserTranscript = async (question: string): Promise<void> => {
    const trimmed = question.trim();
    if (!trimmed || stopped) {
      return;
    }
    if (agentConsultActive) {
      pendingAgentQuestion = trimmed;
      return;
    }
    agentConsultActive = true;
    let nextQuestion: string | undefined = trimmed;
    try {
      while (nextQuestion) {
        if (stopped) {
          return;
        }
        const currentQuestion = nextQuestion;
        pendingAgentQuestion = undefined;
        params.logger.info(`[google-meet] node realtime agent consult: ${currentQuestion}`);
        const result = await consultOpenClawAgentForGoogleMeet({
          config: params.config,
          fullConfig: params.fullConfig,
          runtime: params.runtime,
          logger: params.logger,
          meetingSessionId: params.meetingSessionId,
          requesterSessionKey: params.requesterSessionKey,
          args: {
            question: currentQuestion,
            responseStyle: "Brief, natural spoken answer for a live meeting.",
          },
          transcript,
        });
        if (!stopped && result.text.trim()) {
          bridge?.sendUserMessage(buildGoogleMeetSpeakExactUserMessage(result.text.trim()));
        }
        nextQuestion = pendingAgentQuestion;
      }
    } catch (error) {
      params.logger.warn(
        `[google-meet] node realtime agent consult failed: ${formatErrorMessage(error)}`,
      );
      if (!stopped) {
        bridge?.sendUserMessage(
          buildGoogleMeetSpeakExactUserMessage(
            "I hit an error while checking that. Please try again.",
          ),
        );
      }
    } finally {
      agentConsultActive = false;
      const queuedQuestion = pendingAgentQuestion;
      pendingAgentQuestion = undefined;
      if (queuedQuestion && !stopped) {
        void runAgentConsultForUserTranscript(queuedQuestion);
      }
    }
  };

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (agentConsultDebounceTimer) {
      clearTimeout(agentConsultDebounceTimer);
      agentConsultDebounceTimer = undefined;
    }
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
      if (isFinal) {
        recordGoogleMeetRealtimeTranscript(transcript, role, text);
        params.logger.info(`[google-meet] node realtime ${role}: ${text}`);
        if (role === "user" && strategy === "agent") {
          if (isGoogleMeetLikelyAssistantEchoTranscript({ transcript, text })) {
            params.logger.info(
              `[google-meet] node realtime ignored assistant echo transcript: ${text}`,
            );
            return;
          }
          enqueueAgentConsultForUserTranscript(text);
        }
      }
    },
    onEvent: (event) => {
      recordGoogleMeetRealtimeEvent(realtimeEvents, event);
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
      if (strategy !== "bidi") {
        session.submitToolResult(event.callId || event.itemId, {
          error: `Tool "${event.name}" is only available in bidi realtime strategy`,
        });
        return;
      }
      if (event.name !== GOOGLE_MEET_AGENT_CONSULT_TOOL_NAME) {
        session.submitToolResult(event.callId || event.itemId, {
          error: `Tool "${event.name}" not available`,
        });
        return;
      }
      submitGoogleMeetConsultWorkingResponse(session, event.callId || event.itemId);
      void consultOpenClawAgentForGoogleMeet({
        config: params.config,
        fullConfig: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        meetingSessionId: params.meetingSessionId,
        requesterSessionKey: params.requesterSessionKey,
        args: event.args,
        transcript,
      })
        .then((result) => {
          session.submitToolResult(event.callId || event.itemId, result);
        })
        .catch((error: Error) => {
          session.submitToolResult(event.callId || event.itemId, {
            error: formatErrorMessage(error),
          });
        });
    },
    onError: (error) => {
      params.logger.warn(
        `[google-meet] node realtime voice bridge failed: ${formatErrorMessage(error)}`,
      );
      void stop();
    },
    onClose: (reason) => {
      realtimeReady = false;
      if (reason === "error") {
        void stop();
      }
    },
    onReady: () => {
      realtimeReady = true;
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
      consecutiveInputErrors,
      lastInputError,
      clearCount,
      bridgeClosed: stopped,
    }),
    stop,
  };
}
