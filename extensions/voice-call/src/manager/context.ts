// Voice Call plugin module implements context behavior.
import type { VoiceCallConfig, VoiceCallCoreSessionConfig } from "../config.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { CallId, CallRecord } from "../types.js";

export type CallEndResult = { success: boolean; error?: string };

type TranscriptWaiter = {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  turnToken?: string;
};

type CallManagerRuntimeState = {
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  processedEventIds: Set<string>;
  /** Provider call IDs reserved for reject hangup; avoids duplicate hangup calls. */
  rejectedProviderCallIds: Map<string, symbol>;
};

type CallManagerRuntimeDeps = {
  provider: VoiceCallProvider | null;
  config: VoiceCallConfig;
  coreSession?: VoiceCallCoreSessionConfig;
  storePath: string;
  webhookUrl: string | null;
};

type CallManagerTransientState = {
  activeTurnCalls: Set<CallId>;
  endCallOperations: Map<CallId, Promise<CallEndResult>>;
  transcriptWaiters: Map<CallId, TranscriptWaiter>;
  maxDurationTimers: Map<CallId, NodeJS.Timeout>;
  initialMessageInFlight: Set<CallId>;
};

export type StreamSessionIssuer = (request: {
  providerName: "twilio" | "telnyx";
  callId: CallId;
  from?: string;
  to?: string;
  direction: "inbound" | "outbound";
}) => { token: string; streamUrl: string } | undefined;

type CallManagerHooks = {
  onCallAnswered?: (call: CallRecord) => void;
  onCallerSpeech?: (call: CallRecord) => void;
  streamSessionIssuer?: StreamSessionIssuer;
};

export type CallManagerContext = CallManagerRuntimeState &
  CallManagerRuntimeDeps &
  CallManagerTransientState &
  CallManagerHooks;
