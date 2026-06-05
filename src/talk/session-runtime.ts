// Talk session runtime manages realtime voice session lifecycle and provider wiring.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBargeInOptions,
  RealtimeVoiceCloseReason,
  RealtimeVoiceBridgeEvent,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceRole,
  RealtimeVoiceTool,
  RealtimeVoiceToolCallEvent,
  RealtimeVoiceToolResultOptions,
} from "./provider-types.js";

/**
 * Transport-facing audio target used by realtime voice bridge sessions.
 */
export type RealtimeVoiceAudioSink = {
  isOpen?: () => boolean;
  sendAudio: (audio: Buffer) => void;
  clearAudio?: () => void;
  sendMark?: (markName: string) => void;
};

/**
 * Controls how provider playback marks are bridged to transports that may or may not ack marks.
 */
export type RealtimeVoiceMarkStrategy = "transport" | "ack-immediately" | "ignore";

/**
 * Stable session facade handed to gateway code and provider tool callbacks.
 */
export type RealtimeVoiceBridgeSession = {
  bridge: RealtimeVoiceBridge;
  acknowledgeMark(): void;
  close(): void;
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  sendUserMessage(text: string): void;
  handleBargeIn(options?: RealtimeVoiceBargeInOptions): void;
  setMediaTimestamp(ts: number): void;
  submitToolResult(callId: string, result: unknown, options?: RealtimeVoiceToolResultOptions): void;
  triggerGreeting(instructions?: string): void;
};

/**
 * Provider bridge inputs plus transport callbacks for one realtime voice session.
 */
export type RealtimeVoiceBridgeSessionParams = {
  provider: RealtimeVoiceProviderPlugin;
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
  audioFormat?: RealtimeVoiceAudioFormat;
  audioSink: RealtimeVoiceAudioSink;
  instructions?: string;
  initialGreetingInstructions?: string;
  autoRespondToAudio?: boolean;
  interruptResponseOnInputAudio?: boolean;
  markStrategy?: RealtimeVoiceMarkStrategy;
  triggerGreetingOnReady?: boolean;
  tools?: RealtimeVoiceTool[];
  onTranscript?: (role: RealtimeVoiceRole, text: string, isFinal: boolean) => void;
  onEvent?: (event: RealtimeVoiceBridgeEvent) => void;
  onToolCall?: (event: RealtimeVoiceToolCallEvent, session: RealtimeVoiceBridgeSession) => void;
  onReady?: (session: RealtimeVoiceBridgeSession) => void;
  onError?: (error: Error) => void;
  onClose?: (reason: RealtimeVoiceCloseReason) => void;
};

/**
 * Creates a realtime voice bridge session and wires provider events to the configured audio sink.
 */
export function createRealtimeVoiceBridgeSession(
  params: RealtimeVoiceBridgeSessionParams,
): RealtimeVoiceBridgeSession {
  const bridgeRef: { current?: RealtimeVoiceBridge } = {};
  const requireBridge = () => {
    if (!bridgeRef.current) {
      throw new Error("Realtime voice bridge is not ready");
    }
    return bridgeRef.current;
  };
  // The provider may call callbacks during createBridge(); keep the public session facade
  // stable while blocking use until the bridge object has actually been returned.
  const session: RealtimeVoiceBridgeSession = {
    get bridge() {
      return requireBridge();
    },
    acknowledgeMark: () => requireBridge().acknowledgeMark(),
    close: () => requireBridge().close(),
    connect: () => requireBridge().connect(),
    sendAudio: (audio) => requireBridge().sendAudio(audio),
    sendUserMessage: (text) => requireBridge().sendUserMessage?.(text),
    handleBargeIn: (options) => requireBridge().handleBargeIn?.(options),
    setMediaTimestamp: (ts) => requireBridge().setMediaTimestamp(ts),
    submitToolResult: (callId, result, options) =>
      requireBridge().submitToolResult(callId, result, options),
    triggerGreeting: (instructions) => requireBridge().triggerGreeting?.(instructions),
  };
  const canSendAudio = () => params.audioSink.isOpen?.() ?? true;
  const bridge = params.provider.createBridge({
    cfg: params.cfg,
    providerConfig: params.providerConfig,
    audioFormat: params.audioFormat,
    instructions: params.instructions,
    autoRespondToAudio: params.autoRespondToAudio,
    interruptResponseOnInputAudio: params.interruptResponseOnInputAudio,
    tools: params.tools,
    onAudio: (audio) => {
      if (canSendAudio()) {
        params.audioSink.sendAudio(audio);
      }
    },
    onClearAudio: () => {
      if (canSendAudio()) {
        params.audioSink.clearAudio?.();
      }
    },
    onMark: (markName) => {
      // Some transports send mark acks, some need immediate provider acks, and some ignore
      // playback marks entirely. Keep that policy centralized at the bridge boundary.
      if (!canSendAudio() || params.markStrategy === "ignore") {
        return;
      }
      if (params.markStrategy === "ack-immediately") {
        bridgeRef.current?.acknowledgeMark();
        return;
      }
      if (params.markStrategy === undefined || params.markStrategy === "transport") {
        params.audioSink.sendMark?.(markName);
      }
    },
    onTranscript: params.onTranscript,
    onEvent: params.onEvent,
    onToolCall: (event) => {
      if (!bridgeRef.current) {
        return;
      }
      params.onToolCall?.(event, session);
    },
    onReady: () => {
      if (!bridgeRef.current) {
        return;
      }
      if (params.triggerGreetingOnReady) {
        bridgeRef.current.triggerGreeting?.(params.initialGreetingInstructions);
      }
      params.onReady?.(session);
    },
    onError: params.onError,
    onClose: params.onClose,
  });
  bridgeRef.current = bridge;

  return session;
}
