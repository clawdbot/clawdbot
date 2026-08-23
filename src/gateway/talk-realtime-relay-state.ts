import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/types.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { BoundedSerialQueue } from "../shared/bounded-serial-queue.js";
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
import type { RelayToolCallLedger } from "./talk-realtime-relay-tool-call-ledger.js";

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
  | { relaySessionId: string; type: "toolCallCancelled"; callId: string }
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
  toolCalls: RelayToolCallLedger;
  providerToolCallIds: Map<string, string>;
  relayToolCallIdsByProviderId: Map<string, string>;
  pendingFinalToolResults: Map<string, Promise<void>>;
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
  voiceTranscriptQueue: BoundedSerialQueue;
  voiceSessionClose?: Promise<void>;
  failSession: (message: string) => void;
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
// Closed relays leave the active map immediately so late provider/client events
// are ignored, but their accepted transcript prefix still owns bounded memory
// until durable close settles. Session limits count both maps.
export const drainingRelaySessions = new Set<RelaySession>();

export function adoptRelayProviderToolCallId(
  session: RelaySession,
  providerCallId: string,
): string | undefined {
  const current = session.relayToolCallIdsByProviderId.get(providerCallId);
  if (current) {
    if (
      session.toolCalls.isAgentCompleted(current) ||
      session.toolCalls.isProviderCompleted(providerCallId)
    ) {
      return undefined;
    }
    return current;
  }
  const relayCallId = session.toolCalls.isAgentCompleted(providerCallId)
    ? `relay-${randomUUID()}`
    : providerCallId;
  // Realtime protocols define no replay window. Retain every admitted identity
  // for the session and fail closed at the hard cap instead of evicting dedupe state.
  if (!session.toolCalls.tryAdmit([providerCallId, relayCallId])) {
    return undefined;
  }
  session.toolCalls.deleteProviderCompleted(providerCallId);
  session.toolCalls.deleteAgentCompleted(relayCallId);
  session.providerToolCallIds.set(relayCallId, providerCallId);
  session.relayToolCallIdsByProviderId.set(providerCallId, relayCallId);
  return relayCallId;
}

export function resolveRelayProviderToolCallId(session: RelaySession, relayCallId: string): string {
  return session.providerToolCallIds.get(relayCallId) ?? relayCallId;
}

export function broadcastToOwner(
  context: GatewayRequestContext,
  connId: string,
  event: TalkRealtimeRelayEvent,
): void {
  // Classify the materialized Talk event so final results cannot be mistaken
  // for transient tool progress by individual provider callback paths.
  const delivery = relayEventDeliveryOptions(event, event.talkEvent);
  context.broadcastToConnIds(RELAY_EVENT, event, new Set([connId]), delivery);
}

function relayEventDeliveryOptions(
  event: TalkRealtimeRelayEventPayload,
  talkEvent?: TalkEvent,
): {
  dropIfSlow?: boolean;
} {
  switch (event.type) {
    case "audio":
    case "inputAudio":
      return { dropIfSlow: true };
    case "transcript":
      return { dropIfSlow: !event.final };
    case "toolProgress":
    case "toolResult":
      return { dropIfSlow: talkEvent?.final !== true };
    default:
      return { dropIfSlow: false };
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
