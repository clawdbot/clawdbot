import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceCloseReason,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceRole,
  RealtimeVoiceTool,
  RealtimeVoiceToolCallEvent,
} from "./provider-types.js";

export type RealtimeVoiceAudioSink = {
  isOpen?: () => boolean;
  sendAudio: (muLaw: Buffer) => void;
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
  setMediaTimestamp(ts: number): void;
  submitToolResult(callId: string, result: unknown): void;
  triggerGreeting(instructions?: string): void;
};

export type RealtimeVoiceBridgeSessionParams = {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  audioSink: RealtimeVoiceAudioSink;
  instructions?: string;
  initialGreetingInstructions?: string;
  markStrategy?: RealtimeVoiceMarkStrategy;
  triggerGreetingOnReady?: boolean;
  tools?: RealtimeVoiceTool[];
  onTranscript?: (role: RealtimeVoiceRole, text: string, isFinal: boolean) => void;
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
    setMediaTimestamp: (ts) => requireBridge().setMediaTimestamp(ts),
    submitToolResult: (callId, result) => requireBridge().submitToolResult(callId, result),
    triggerGreeting: (instructions) => requireBridge().triggerGreeting?.(instructions),
  };
  const canSendAudio = () => params.audioSink.isOpen?.() ?? true;
  bridge = params.provider.createBridge({
    providerConfig: params.providerConfig,
    instructions: params.instructions,
    tools: params.tools,
    onAudio: (muLaw) => {
      if (canSendAudio()) {
        params.audioSink.sendAudio(muLaw);
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
