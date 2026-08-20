// Talk session runtime manages realtime voice session lifecycle and provider wiring.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceAudioClearReason,
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBargeInOptions,
  RealtimeVoiceCloseReason,
  RealtimeVoiceBridgeEvent,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceResponseOutcome,
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
  clearAudio?: (reason?: RealtimeVoiceAudioClearReason) => void;
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
  acknowledgeMark(markName?: string): void;
  close(): void;
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  sendUserMessage(text: string): void;
  handleBargeIn(options?: RealtimeVoiceBargeInOptions): void;
  setMediaTimestamp(ts: number): void;
  submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void | Promise<void>;
  triggerGreeting(instructions?: string): void;
};

/**
 * Provider bridge inputs plus transport callbacks for one realtime voice session.
 */
export type RealtimeVoiceBridgeSessionParams = {
  provider: RealtimeVoiceProviderPlugin;
  cfg?: OpenClawConfig;
  /** Host-selected agent scope for provider auth and agent-owned bridge state. */
  agentId?: string;
  providerConfig: RealtimeVoiceProviderConfig;
  audioFormat?: RealtimeVoiceAudioFormat;
  audioSink: RealtimeVoiceAudioSink;
  instructions?: string;
  language?: string;
  initialGreetingInstructions?: string;
  autoRespondToAudio?: boolean;
  interruptResponseOnInputAudio?: boolean;
  markStrategy?: RealtimeVoiceMarkStrategy;
  triggerGreetingOnReady?: boolean;
  tools?: RealtimeVoiceTool[];
  onTranscript?: (role: RealtimeVoiceRole, text: string, isFinal: boolean) => void;
  onEvent?: (event: RealtimeVoiceBridgeEvent) => void;
  onResponseDone?: (outcome: RealtimeVoiceResponseOutcome) => void;
  onToolCall?: (
    event: RealtimeVoiceToolCallEvent,
    session: RealtimeVoiceBridgeSession,
  ) => void | Promise<void>;
  onReady?: (session: RealtimeVoiceBridgeSession) => void;
  onError?: (error: Error) => void;
  onClose?: (reason: RealtimeVoiceCloseReason) => void;
};

type RealtimeVoiceSessionPhase = "admitting" | "provider-terminal" | "disposed";

/**
 * Creates a realtime voice bridge session and wires provider events to the configured audio sink.
 */
export function createRealtimeVoiceBridgeSession(
  params: RealtimeVoiceBridgeSessionParams,
): RealtimeVoiceBridgeSession {
  const bridgeRef: { current?: RealtimeVoiceBridge } = {};
  // Local disposal owns provider cleanup. Only a terminal callback fired before bridge
  // adoption may reopen; adopted bridges own reconnects and stale-event fencing internally.
  let phase: RealtimeVoiceSessionPhase = "admitting";
  let terminalBeforeBridgeAdoption = false;
  let closeReported = false;
  const isAdmitting = () => phase === "admitting";
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
    acknowledgeMark: (markName) => requireBridge().acknowledgeMark(markName),
    close: () => {
      if (phase === "disposed") {
        return;
      }
      const bridge = requireBridge();
      phase = "disposed";
      bridge.close();
    },
    connect: () => {
      if (phase === "disposed") {
        return Promise.reject(new Error("Realtime voice session is closed"));
      }
      if (phase === "provider-terminal") {
        if (!terminalBeforeBridgeAdoption) {
          return Promise.reject(new Error("Realtime voice connection is closed"));
        }
        terminalBeforeBridgeAdoption = false;
        phase = "admitting";
        closeReported = false;
      }
      return requireBridge().connect();
    },
    sendAudio: (audio) => {
      if (isAdmitting()) {
        requireBridge().sendAudio(audio);
      }
    },
    sendUserMessage: (text) => requireBridge().sendUserMessage?.(text),
    handleBargeIn: (options) => requireBridge().handleBargeIn?.(options),
    setMediaTimestamp: (ts) => requireBridge().setMediaTimestamp(ts),
    submitToolResult: (callId, result, options) => {
      const bridge = requireBridge();
      if (options?.suppressResponse && bridge.supportsToolResultSuppression === false) {
        throw new Error("Realtime provider does not support suppressed tool results");
      }
      return bridge.submitToolResult(callId, result, options);
    },
    triggerGreeting: (instructions) => requireBridge().triggerGreeting?.(instructions),
  };
  // Session inactivity is the shared admission boundary for both audio directions.
  // Provider and transport callbacks may still race after close, but cannot retain new audio.
  const canSendAudio = () => isAdmitting() && (params.audioSink.isOpen?.() ?? true);
  const reportCallbackError = (error: unknown) => {
    // Async tool handlers can settle after the provider closes. Once inactive, no
    // callback may report stale failures into the next session lifecycle.
    if (!isAdmitting()) {
      return;
    }
    try {
      params.onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // An error callback is the terminal boundary for provider callback failures.
    }
  };
  const bridge = params.provider.createBridge({
    cfg: params.cfg,
    agentId: params.agentId,
    providerConfig: params.providerConfig,
    audioFormat: params.audioFormat,
    instructions: params.instructions,
    language: params.language,
    autoRespondToAudio: params.autoRespondToAudio,
    interruptResponseOnInputAudio: params.interruptResponseOnInputAudio,
    tools: params.tools,
    onAudio: (audio) => {
      if (canSendAudio()) {
        params.audioSink.sendAudio(audio);
      }
    },
    onClearAudio: (reason) => {
      if (canSendAudio()) {
        params.audioSink.clearAudio?.(reason);
      }
    },
    onMark: (markName) => {
      // Some transports send mark acks, some need immediate provider acks, and some ignore
      // playback marks entirely. Keep that policy centralized at the bridge boundary.
      if (!canSendAudio() || params.markStrategy === "ignore") {
        return;
      }
      if (params.markStrategy === "ack-immediately") {
        bridgeRef.current?.acknowledgeMark(markName);
        return;
      }
      if (params.markStrategy === undefined || params.markStrategy === "transport") {
        params.audioSink.sendMark?.(markName);
      }
    },
    onTranscript: params.onTranscript,
    onEvent: params.onEvent,
    onResponseDone: params.onResponseDone,
    onToolCall: (event) => {
      if (!bridgeRef.current || !isAdmitting()) {
        return;
      }
      try {
        const pending = params.onToolCall?.(event, session);
        if (pending) {
          void pending.catch(reportCallbackError);
        }
      } catch (error) {
        reportCallbackError(error);
      }
    },
    onReady: () => {
      if (!bridgeRef.current || !isAdmitting()) {
        return;
      }
      if (params.triggerGreetingOnReady) {
        bridgeRef.current.triggerGreeting?.(params.initialGreetingInstructions);
      }
      params.onReady?.(session);
    },
    onError: params.onError,
    onClose: (reason) => {
      if (!bridgeRef.current) {
        terminalBeforeBridgeAdoption = true;
      }
      if (phase !== "disposed") {
        phase = "provider-terminal";
      }
      if (closeReported) {
        return;
      }
      closeReported = true;
      params.onClose?.(reason);
    },
  });
  bridgeRef.current = bridge;

  return session;
}
