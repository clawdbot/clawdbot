import type { OpenClawConfig } from "../config/types.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { RealtimeVoiceAgentControlResult } from "../talk/agent-run-control.js";
import type {
  RealtimeVoiceBrowserAudioContract,
  RealtimeVoiceAudioClearReason,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceTool,
  RealtimeVoiceToolResultOptions,
} from "../talk/provider-types.js";
import type { RealtimeVoiceSessionHarness } from "../talk/realtime-session-harness.js";
import type { RealtimeVoiceBridgeSession } from "../talk/session-runtime.js";
import type { TalkEvent } from "../talk/talk-session-controller.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

export const RELAY_SESSION_TTL_MS = 30 * 60 * 1000;
export const MAX_AUDIO_BASE64_BYTES = 512 * 1024;
export const MAX_RELAY_SESSIONS_PER_CONN = 2;
export const MAX_RELAY_SESSIONS_GLOBAL = 64;
const RELAY_EVENT = "talk.event";
export const RELAY_TRANSCRIPT_ECHO_LOOKBACK_MS = 12_000;

export const noFallbackRelayOutputFlush = () => {};

export type TalkRealtimeRelayEventPayload =
  | { relaySessionId: string; type: "ready" }
  | { relaySessionId: string; type: "inputAudio"; byteLength: number }
  | {
      relaySessionId: string;
      type: "audio";
      audioBase64: string;
      itemId?: string;
      responseId?: string;
    }
  | { relaySessionId: string; type: "audioDone"; itemId?: string; responseId?: string }
  | { relaySessionId: string; type: "clear"; reason?: RealtimeVoiceAudioClearReason }
  | { relaySessionId: string; type: "mark"; markName: string }
  | {
      relaySessionId: string;
      type: "transcript";
      role: "user" | "assistant";
      text: string;
      final: boolean;
    }
  | {
      relaySessionId: string;
      type: "toolCall";
      itemId: string;
      callId: string;
      name: string;
      args: unknown;
      forced?: boolean;
    }
  | { relaySessionId: string; type: "toolResult"; callId: string }
  | { relaySessionId: string; type: "toolProgress"; result: RealtimeVoiceAgentControlResult }
  | {
      relaySessionId: string;
      type: "error";
      message: string;
      code?: "realtime_unavailable";
      provider?: string;
      model?: string;
      transport?: "gateway-relay";
      phase?: string;
    }
  | { relaySessionId: string; type: "close"; reason: "completed" | "error" };

type TalkRealtimeRelayEvent = TalkRealtimeRelayEventPayload & { talkEvent?: TalkEvent };

export type ForcedTerminalProviderResult = {
  result: unknown;
  options?: RealtimeVoiceToolResultOptions;
  turnId: string;
  epoch: number;
};

export type RelayAgentControlProviderSubmission = {
  completion?: Promise<void>;
  providerResponseStarted: boolean;
};

export type RelaySession = {
  id: string;
  connId: string;
  context: GatewayRequestContext;
  bridge: RealtimeVoiceBridgeSession;
  harness: RealtimeVoiceSessionHarness;
  sessionKey?: string;
  agentId?: string;
  expiresAtMs: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
  activeAgentRuns: Map<string, string>;
  provider: string;
  activeAgentToolCalls: Map<string, string>;
  completedAgentToolCalls: Set<string>;
  // Cancelled calls retain their original turn long enough to terminally satisfy
  // late browser results without creating a replacement turn or owner success event.
  cancelledAgentToolCalls: Map<string, string>;
  pendingFinalToolResults: Map<string, Promise<void>>;
  // Provider acceptance survives partial retries independently from the owner-facing
  // agent-call lifecycle, so accepted native ids are never submitted twice.
  completedProviderToolResults: Set<string>;
  pendingProviderToolResults: Map<string, Promise<void>>;
  // A final result must wait until the provider accepts its continuation result;
  // otherwise async bridges can observe final-before-working ordering.
  pendingWorkingToolResults: Map<string, Promise<void>>;
  // Keep a forced terminal result open while late matching native ids join it.
  // Delivery/cancellation closes the state only after every current id accepts.
  forcedTerminalProviderResults: Map<string, ForcedTerminalProviderResult>;
  // Turn cancellation invalidates async acceptance callbacks from the prior turn.
  toolResultEpoch: number;
  voiceConfig?: OpenClawConfig;
  voiceSessionCreated: boolean;
  voiceTranscriptSeq: number;
  voiceTranscriptWrites: Promise<void>;
  pendingVoiceTranscripts: Array<{ role: "user" | "assistant"; text: string }>;
};

export type CreateTalkRealtimeRelaySessionParams = {
  context: GatewayRequestContext;
  connId: string;
  cfg?: OpenClawConfig;
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  instructions: string;
  tools: RealtimeVoiceTool[];
  model?: string;
  sessionKey?: string;
  voice?: string;
  language?: string;
  forceAgentConsultOnFinalTranscript?: boolean;
};

export type TalkRealtimeRelaySessionResult = {
  provider: string;
  transport: "gateway-relay";
  relaySessionId: string;
  audio: RealtimeVoiceBrowserAudioContract;
  model?: string;
  voice?: string;
  expiresAt: number;
};

export const relaySessions = new Map<string, RelaySession>();

export function broadcastToOwner(
  context: GatewayRequestContext,
  connId: string,
  event: TalkRealtimeRelayEvent,
  options: { dropIfSlow?: boolean } = { dropIfSlow: true },
): void {
  context.broadcastToConnIds(RELAY_EVENT, event, new Set([connId]), options);
}

export function relayEventDeliveryOptions(event: TalkRealtimeRelayEventPayload): {
  dropIfSlow?: boolean;
} {
  switch (event.type) {
    case "ready":
    case "error":
    case "close":
    case "mark":
      return { dropIfSlow: false };
    default:
      return { dropIfSlow: true };
  }
}

export function ensureRelayTurn(session: RelaySession): string {
  const turn = session.harness.talk.ensureTurn();
  if (turn.event) {
    broadcastToOwner(session.context, session.connId, {
      relaySessionId: session.id,
      type: "inputAudio",
      byteLength: 0,
      talkEvent: turn.event,
    });
  }
  return turn.turnId;
}
