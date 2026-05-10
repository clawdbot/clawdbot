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

export type RealtimeVoiceAudioSink = {
  isOpen?: () => boolean;
  sendAudio: (audio: Buffer) => void;
  clearAudio?: () => void;
  sendMark?: (markName: string) => void;
};

export type RealtimeVoiceMarkStrategy = "transport" | "ack-immediately" | "ignore";

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

export function createRealtimeVoiceBridgeSession(
  params: RealtimeVoiceBridgeSessionParams,
): RealtimeVoiceBridgeSession {
  let bridge: RealtimeVoiceBridge | undefined;
  const requireBridge = () => {
    if (!bridge) {
      throw new Error("Realtime voice bridge is not ready");
    }
    return bridge;
  };
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
  bridge = params.provider.createBridge({
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
      if (!canSendAudio() || params.markStrategy === "ignore") {
        return;
      }
      if (params.markStrategy === "ack-immediately") {
        bridge?.acknowledgeMark();
        return;
      }
      if (params.markStrategy === undefined || params.markStrategy === "transport") {
        params.audioSink.sendMark?.(markName);
      }
    },
    onTranscript: params.onTranscript,
    onEvent: params.onEvent,
    onToolCall: (event) => {
      if (!bridge) {
        return;
      }
      params.onToolCall?.(event, session);
    },
    onReady: () => {
      if (!bridge) {
        return;
      }
      if (params.triggerGreetingOnReady) {
        bridge.triggerGreeting?.(params.initialGreetingInstructions);
      }
      params.onReady?.(session);
    },
    onError: params.onError,
    onClose: params.onClose,
  });

  return session;
}
