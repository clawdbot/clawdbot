// Talk provider types describe realtime voice provider configuration and APIs.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TalkTransport } from "./talk-events.js";

export type RealtimeVoiceProviderId = string;

export type RealtimeVoiceRole = "user" | "assistant";

export type RealtimeVoiceCloseReason = "completed" | "error";

export type RealtimeVoiceAudioFormat =
  | {
      encoding: "g711_ulaw";
      sampleRateHz: 8000;
      channels: 1;
    }
  | {
      encoding: "pcm16";
      sampleRateHz: 24000;
      channels: 1;
    };

export function realtimeVoiceAudioDurationMs(
  format: RealtimeVoiceAudioFormat,
  byteLength: number,
): number {
  const bytesPerSample = format.encoding === "pcm16" ? 2 : 1;
  return (byteLength * 1000) / (format.sampleRateHz * format.channels * bytesPerSample);
}

export type OpenAICompatibleRealtimeAudioFormat =
  | { type: "audio/pcm"; rate: 24000 }
  | { type: "audio/pcmu" };

export function toOpenAICompatibleRealtimeAudioFormat(
  format: RealtimeVoiceAudioFormat,
): OpenAICompatibleRealtimeAudioFormat {
  return format.encoding === "pcm16" ? { type: "audio/pcm", rate: 24000 } : { type: "audio/pcmu" };
}

export const REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ: RealtimeVoiceAudioFormat = {
  encoding: "g711_ulaw",
  sampleRateHz: 8000,
  channels: 1,
};

export const REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ: RealtimeVoiceAudioFormat = {
  encoding: "pcm16",
  sampleRateHz: 24000,
  channels: 1,
};

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

export type RealtimeVoiceToolResultOptions = {
  /**
   * Submit the tool result without prompting the realtime provider to generate a new assistant
   * response. Use when another channel has already delivered the user-visible answer.
   */
  suppressResponse?: boolean;
  willContinue?: boolean;
};

export type RealtimeVoiceCloseDisposition = "abort" | "detach";

export type RealtimeVoiceCloseOptions = {
  /** Whether closing the transport also cancels work already accepted by the host. */
  disposition?: RealtimeVoiceCloseDisposition;
};

export type RealtimeVoiceBridgeEvent = {
  direction: "client" | "server";
  type: string;
  detail?: string;
  itemId?: string;
  responseId?: string;
};

export type RealtimeVoiceResponseError = {
  code?: string;
  message?: string;
  type?: string;
};

type RealtimeVoiceResponseOutcomeBase = {
  responseId?: string;
};

export type RealtimeVoiceResponseOutcome =
  | (RealtimeVoiceResponseOutcomeBase & { status: "completed" })
  | (RealtimeVoiceResponseOutcomeBase & { status: "cancelled"; reason?: string })
  | (RealtimeVoiceResponseOutcomeBase & {
      status: "failed" | "incomplete";
      reason?: string;
      error?: RealtimeVoiceResponseError;
      message: string;
    });

/** Normalizes OpenAI-style realtime response status details into the shared Talk contract. */
export function normalizeRealtimeVoiceResponseOutcome(params: {
  providerLabel: string;
  response: unknown;
  responseId?: unknown;
}): RealtimeVoiceResponseOutcome {
  const response = isRecord(params.response) ? params.response : undefined;
  const details = isRecord(response?.status_details) ? response.status_details : undefined;
  const rawError = isRecord(details?.error) ? details.error : undefined;
  const code = normalizeOptionalString(rawError?.code);
  const errorMessage = normalizeOptionalString(rawError?.message);
  const errorType = normalizeOptionalString(rawError?.type);
  const error =
    code || errorMessage || errorType
      ? {
          ...(code ? { code } : {}),
          ...(errorMessage ? { message: errorMessage } : {}),
          ...(errorType ? { type: errorType } : {}),
        }
      : undefined;
  const reason = normalizeOptionalString(details?.reason);
  const responseId =
    normalizeOptionalString(response?.id) ?? normalizeOptionalString(params.responseId);
  const base = responseId ? { responseId } : {};
  switch (response?.status) {
    case "completed":
      return { ...base, status: "completed" };
    case "cancelled":
      return { ...base, status: "cancelled", ...(reason ? { reason } : {}) };
    case "failed":
    case "incomplete": {
      const status = response.status;
      const detail = [reason, errorMessage ?? code ?? errorType].filter(Boolean).join(": ");
      return {
        ...base,
        status,
        ...(reason ? { reason } : {}),
        ...(error ? { error } : {}),
        message: `${params.providerLabel} response ${status}${detail ? `: ${detail}` : ""}`,
      };
    }
    default: {
      const rawStatus = normalizeOptionalString(response?.status);
      const detail = rawStatus ? `invalid status ${rawStatus}` : "missing terminal status";
      return {
        ...base,
        status: "failed",
        reason: "invalid_response_status",
        error: { type: "invalid_response_status", message: detail },
        message: `${params.providerLabel} response failed: ${detail}`,
      };
    }
  }
}

export type RealtimeVoiceAudioClearReason = "barge-in";

export type RealtimeVoiceBridgeCallbacks = {
  onAudio: (audio: Buffer) => void;
  onClearAudio: (reason?: RealtimeVoiceAudioClearReason) => void;
  onMark?: (markName: string) => void;
  onTranscript?: (role: RealtimeVoiceRole, text: string, isFinal: boolean) => void;
  onEvent?: (event: RealtimeVoiceBridgeEvent) => void;
  onResponseDone?: (outcome: RealtimeVoiceResponseOutcome) => void;
  onToolCall?: (event: RealtimeVoiceToolCallEvent) => void;
  onReady?: () => void;
  onError?: (error: Error) => void;
  onClose?: (reason: RealtimeVoiceCloseReason) => void;
};

export type RealtimeVoiceProviderConfig = Record<string, unknown>;

export type RealtimeVoiceProviderCapabilities = {
  transports: TalkTransport[];
  inputAudioFormats: RealtimeVoiceAudioFormat[];
  outputAudioFormats: RealtimeVoiceAudioFormat[];
  supportsBrowserSession?: boolean;
  supportsBargeIn?: boolean;
  /** True when provider VAD reports confirmed interruptions through onClearAudio("barge-in"). */
  handlesInputAudioBargeIn?: boolean;
  supportsToolCalls?: boolean;
  /** True when user transcripts are reliable enough to gate responses on a leading wake name. */
  supportsActivationNameGating?: boolean;
  supportsVideoFrames?: boolean;
  supportsSessionResumption?: boolean;
};

export type RealtimeVoiceProviderResolveConfigContext = {
  cfg: OpenClawConfig;
  rawConfig: RealtimeVoiceProviderConfig;
};

export type RealtimeVoiceProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  /** Host-selected agent scope for provider auth readiness. */
  agentId?: string;
  providerConfig: RealtimeVoiceProviderConfig;
};

export type RealtimeVoiceAgentConsultRunner = (params: {
  prompt: string;
  signal?: AbortSignal;
}) => Promise<{ text: string }>;

export type RealtimeVoiceBridgeCreateRequest = RealtimeVoiceBridgeCallbacks & {
  cfg?: OpenClawConfig;
  /** Host-selected agent scope for provider auth and agent-owned bridge state. */
  agentId?: string;
  providerConfig: RealtimeVoiceProviderConfig;
  audioFormat?: RealtimeVoiceAudioFormat;
  instructions?: string;
  language?: string;
  autoRespondToAudio?: boolean;
  interruptResponseOnInputAudio?: boolean;
  tools?: RealtimeVoiceTool[];
  /** Host-injected agent delegation runner for provider-owned realtime control channels. */
  runAgentConsult?: RealtimeVoiceAgentConsultRunner;
};

export type RealtimeVoiceBrowserSessionCreateRequest = {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
  instructions?: string;
  tools?: RealtimeVoiceTool[];
  model?: string;
  voice?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  reasoningEffort?: string;
  /** Host-injected agent delegation runner for provider-owned realtime control channels. */
  runAgentConsult?: RealtimeVoiceAgentConsultRunner;
  /** Host-owned control callbacks for browser media sessions whose provider wire stays server-side. */
  gatewayControl?: RealtimeVoiceGatewayControl;
};

/** Narrow host/plugin seam for Gateway-owned control of a client-owned media session. */
export type RealtimeVoiceGatewayControl = Omit<
  RealtimeVoiceBridgeCallbacks,
  "onAudio" | "onClearAudio" | "onMark"
> & {
  bindBridge: (bridge: RealtimeVoiceBridge) => void;
};

export type RealtimeVoiceBrowserAudioContract = {
  inputEncoding: "pcm16" | "g711_ulaw";
  inputSampleRateHz: number;
  outputEncoding: "pcm16" | "g711_ulaw";
  outputSampleRateHz: number;
};

type RealtimeVoiceBrowserWebRtcSdpSession = {
  provider: RealtimeVoiceProviderId;
  transport: "webrtc";
  clientSecret: string;
  offerUrl?: string;
  offerHeaders?: Record<string, string>;
  model?: string;
  voice?: string;
  expiresAt?: number;
};

type RealtimeVoiceBrowserJsonPcmWebSocketSession = {
  provider: RealtimeVoiceProviderId;
  transport: "provider-websocket";
  protocol: string;
  clientSecret: string;
  websocketUrl: string;
  audio: RealtimeVoiceBrowserAudioContract;
  initialMessage?: unknown;
  model?: string;
  voice?: string;
  expiresAt?: number;
};

type RealtimeVoiceBrowserGatewayRelaySession = {
  provider: RealtimeVoiceProviderId;
  transport: "gateway-relay";
  relaySessionId: string;
  audio: RealtimeVoiceBrowserAudioContract;
  model?: string;
  voice?: string;
  expiresAt?: number;
};

type RealtimeVoiceBrowserManagedRoomSession = {
  provider: RealtimeVoiceProviderId;
  transport: "managed-room";
  roomUrl: string;
  token?: string;
  model?: string;
  voice?: string;
  expiresAt?: number;
};

export type RealtimeVoiceBrowserSession =
  | RealtimeVoiceBrowserWebRtcSdpSession
  | RealtimeVoiceBrowserJsonPcmWebSocketSession
  | RealtimeVoiceBrowserGatewayRelaySession
  | RealtimeVoiceBrowserManagedRoomSession;

export type RealtimeVoiceBridge = {
  supportsToolResultContinuation?: boolean;
  /** False when the provider cannot accept a tool result without starting a response. */
  supportsToolResultSuppression?: boolean;
  /** Per-session override for provider-confirmed input-audio barge-in handling. */
  handlesInputAudioBargeIn?: boolean;
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  setMediaTimestamp(ts: number): void;
  sendUserMessage?(
    text: string,
    options?: { toolChoice?: { type: "function"; name: string } },
  ): void;
  triggerGreeting?(instructions?: string): void;
  handleBargeIn?(options?: RealtimeVoiceBargeInOptions): void;
  /**
   * Returns void when submission completes synchronously, or a Promise that resolves at the
   * asynchronous completion boundary exposed by the provider and rejects on submission failure.
   */
  submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void | Promise<void>;
  acknowledgeMark(markName?: string): void;
  close(options?: RealtimeVoiceCloseOptions): void;
  isConnected(): boolean;
};

export type RealtimeVoiceBargeInOptions = {
  /**
   * The caller has already confirmed assistant audio is still playing in its output sink.
   * This lets providers interrupt output even when the sink cannot provide real playback marks.
   */
  audioPlaybackActive?: boolean;
  /** Interrupt even when normal barge-in audio-duration guards would treat the event as echo. */
  force?: boolean;
};
