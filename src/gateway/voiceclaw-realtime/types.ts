export type VoiceClawClientEvent =
  | VoiceClawSessionConfigEvent
  | VoiceClawAudioAppendEvent
  | VoiceClawAudioCommitEvent
  | VoiceClawFrameAppendEvent
  | VoiceClawResponseCreateEvent
  | VoiceClawResponseCancelEvent
  | VoiceClawToolResultEvent;

export type VoiceClawSessionConfigEvent = {
  type: "session.config";
  provider?: "openai" | "gemini";
  voice?: string;
  model?: string;
  brainAgent?: "enabled" | "none";
  apiKey?: string;
  sessionKey?: string;
  userId?: string;
  deviceContext?: {
    timezone?: string;
    locale?: string;
    deviceModel?: string;
    location?: string;
  };
  watchdog?: "enabled" | "disabled";
  instructionsOverride?: string;
  conversationHistory?: { role: "user" | "assistant"; text: string }[];
};

export type VoiceClawAudioAppendEvent = {
  type: "audio.append";
  data: string;
};

export type VoiceClawAudioCommitEvent = {
  type: "audio.commit";
};

export type VoiceClawFrameAppendEvent = {
  type: "frame.append";
  data: string;
  mimeType?: string;
};

export type VoiceClawResponseCreateEvent = {
  type: "response.create";
};

export type VoiceClawResponseCancelEvent = {
  type: "response.cancel";
};

export type VoiceClawToolResultEvent = {
  type: "tool.result";
  callId: string;
  output: string;
};

export type VoiceClawServerEvent =
  | VoiceClawSessionReadyEvent
  | VoiceClawAudioDeltaEvent
  | VoiceClawTranscriptDeltaEvent
  | VoiceClawTranscriptDoneEvent
  | VoiceClawToolCallEvent
  | VoiceClawToolProgressEvent
  | VoiceClawTurnStartedEvent
  | VoiceClawTurnEndedEvent
  | VoiceClawSessionEndedEvent
  | VoiceClawSessionRotatingEvent
  | VoiceClawSessionRotatedEvent
  | VoiceClawUsageMetricsEvent
  | VoiceClawLatencyMetricsEvent
  | VoiceClawToolCancelledEvent
  | VoiceClawErrorEvent;

export type VoiceClawSessionReadyEvent = {
  type: "session.ready";
  sessionId: string;
};

export type VoiceClawAudioDeltaEvent = {
  type: "audio.delta";
  data: string;
};

export type VoiceClawTranscriptDeltaEvent = {
  type: "transcript.delta";
  text: string;
  role: "user" | "assistant";
};

export type VoiceClawTranscriptDoneEvent = {
  type: "transcript.done";
  text: string;
  role: "user" | "assistant";
};

export type VoiceClawToolCallEvent = {
  type: "tool.call";
  callId: string;
  name: string;
  arguments: string;
};

export type VoiceClawToolProgressEvent = {
  type: "tool.progress";
  callId: string;
  summary: string;
};

export type VoiceClawTurnStartedEvent = {
  type: "turn.started";
  turnId?: string;
};

export type VoiceClawTurnEndedEvent = {
  type: "turn.ended";
};

export type VoiceClawSessionEndedEvent = {
  type: "session.ended";
  summary: string;
  durationSec: number;
  turnCount: number;
};

export type VoiceClawSessionRotatingEvent = {
  type: "session.rotating";
};

export type VoiceClawSessionRotatedEvent = {
  type: "session.rotated";
  sessionId: string;
};

export type VoiceClawUsageMetricsEvent = {
  type: "usage.metrics";
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  inputAudioTokens?: number;
  outputAudioTokens?: number;
};

export type VoiceClawLatencyMetricsEvent = {
  type: "latency.metrics";
  endpointMs?: number;
  endpointSource?: string;
  providerFirstByteMs?: number;
  firstAudioFromTurnStartMs?: number;
  firstTextFromTurnStartMs?: number;
  firstOutputFromTurnStartMs?: number;
  firstOutputModality?: string;
};

export type VoiceClawToolCancelledEvent = {
  type: "tool.cancelled";
  callIds: string[];
};

export type VoiceClawErrorEvent = {
  type: "error";
  message: string;
  code: number;
};

export type VoiceClawSendToClient = (event: VoiceClawServerEvent) => void;

export type VoiceClawRealtimeToolDeclaration = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type VoiceClawRealtimeAdapterOptions = {
  tools?: VoiceClawRealtimeToolDeclaration[];
};

export type VoiceClawRealtimeAdapter = {
  connect(
    config: VoiceClawSessionConfigEvent,
    sendToClient: VoiceClawSendToClient,
    options?: VoiceClawRealtimeAdapterOptions,
  ): Promise<void>;
  sendAudio(data: string): void;
  commitAudio(): void;
  sendFrame(data: string, mimeType?: string): void;
  createResponse(): void;
  cancelResponse(): void;
  beginAsyncToolCall(callId: string): void;
  finishAsyncToolCall(callId: string): void;
  sendToolResult(callId: string, output: string): void;
  injectContext(text: string): void;
  getTranscript(): { role: "user" | "assistant"; text: string }[];
  disconnect(): void;
};
