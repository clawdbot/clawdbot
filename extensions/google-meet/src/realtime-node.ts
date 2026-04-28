import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
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
  resolveGoogleMeetRealtimeAudioFormat,
  resolveGoogleMeetRealtimeProvider,
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

export async function startNodeRealtimeAudioBridge(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  meetingSessionId: string;
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
  let consecutiveInputErrors = 0;
  let lastInputError: string | undefined;
  let clearCount = 0;
  const resolved = resolveGoogleMeetRealtimeProvider({
    config: params.config,
    fullConfig: params.fullConfig,
    providers: params.providers,
  });
  const transcript: Array<{ role: "user" | "assistant"; text: string }> = [];

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
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
    triggerGreetingOnReady: false,
    markStrategy: "ack-immediately",
    tools: resolveGoogleMeetRealtimeTools(params.config.realtime.toolPolicy),
    audioSink: {
      isOpen: () => !stopped,
      sendAudio: (audio) => {
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
        transcript.push({ role, text });
        if (transcript.length > 40) {
          transcript.splice(0, transcript.length - 40);
        }
        params.logger.debug?.(`[google-meet] ${role}: ${text}`);
      }
    },
    onToolCall: (event, session) => {
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
      lastClearAt,
      lastInputBytes,
      lastOutputBytes,
      consecutiveInputErrors,
      lastInputError,
      clearCount,
      bridgeClosed: stopped,
    }),
    stop,
  };
}
