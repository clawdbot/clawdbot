import type { OpenClawConfig } from "../config/types.openclaw.js";

export type RealtimeVoiceProviderId = string;

export type RealtimeVoiceRole = "user" | "assistant";

export type RealtimeVoiceCloseReason = "completed" | "error";

export type RealtimeVoiceTool = {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export type RealtimeVoiceToolCallEvent = {
  itemId: string;
  callId: string;
  name: string;
  args: unknown;
};

export type RealtimeVoiceBridgeCallbacks = {
  onAudio: (muLaw: Buffer) => void;
  onClearAudio: () => void;
  onMark?: (markName: string) => void;
  onTranscript?: (role: RealtimeVoiceRole, text: string, isFinal: boolean) => void;
  onToolCall?: (event: RealtimeVoiceToolCallEvent) => void;
  onReady?: () => void;
  onError?: (error: Error) => void;
  onClose?: (reason: RealtimeVoiceCloseReason) => void;
};

export type RealtimeVoiceProviderConfig = Record<string, unknown>;

export type RealtimeVoiceProviderResolveConfigContext = {
  cfg: OpenClawConfig;
  rawConfig: RealtimeVoiceProviderConfig;
};

export type RealtimeVoiceProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
};

export type RealtimeVoiceBridgeCreateRequest = RealtimeVoiceBridgeCallbacks & {
  providerConfig: RealtimeVoiceProviderConfig;
  instructions?: string;
  tools?: RealtimeVoiceTool[];
};

export type RealtimeVoiceBrowserSessionCreateRequest = {
  providerConfig: RealtimeVoiceProviderConfig;
  instructions?: string;
  tools?: RealtimeVoiceTool[];
  model?: string;
  voice?: string;
};

export type RealtimeVoiceBrowserSession = {
  provider: RealtimeVoiceProviderId;
  clientSecret: string;
  model?: string;
  voice?: string;
  expiresAt?: number;
};

export type RealtimeVoiceBridge = {
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  setMediaTimestamp(ts: number): void;
  sendUserMessage?(text: string): void;
  triggerGreeting?(instructions?: string): void;
  submitToolResult(callId: string, result: unknown): void;
  acknowledgeMark(): void;
  close(): void;
  isConnected(): boolean;
};
