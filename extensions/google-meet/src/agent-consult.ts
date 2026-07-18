// Google Meet supplies surface labels; core owns generic meeting consult wiring.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  consultMeetingAgent,
  handleMeetingRealtimeConsultToolCall,
  resolveMeetingRealtimeTools,
  type MeetingAgentConsultSurface,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  RealtimeVoiceBridgeSession,
  RealtimeVoiceToolCallEvent,
  RealtimeVoiceTool,
  TalkEventInput,
} from "openclaw/plugin-sdk/realtime-voice";
import type { GoogleMeetConfig, GoogleMeetToolPolicy } from "./config.js";

const GOOGLE_MEET_CONSULT_SURFACE: MeetingAgentConsultSurface = {
  id: "google-meet",
  provider: "google-meet",
  lane: "google-meet",
  surface: "a private Google Meet",
  userLabel: "Participant",
  assistantLabel: "Agent",
  questionSourceLabel: "participant",
  workingResponseLabel: "participant",
  extraSystemPrompt: [
    "You are a behind-the-scenes consultant for a live meeting voice agent.",
    "Prioritize a fast, speakable answer over exhaustive investigation.",
    "For tool-backed status checks, prefer one or two bounded read-only queries before answering.",
    "Do not print secret values or dump environment variables; only check whether required configuration is present.",
    "Be accurate, brief, and speakable.",
  ].join(" "),
};

export function resolveGoogleMeetRealtimeTools(policy: GoogleMeetToolPolicy): RealtimeVoiceTool[] {
  return resolveMeetingRealtimeTools(policy);
}

export async function consultOpenClawAgentForGoogleMeet(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  meetingSessionId: string;
  requesterSessionKey?: string;
  args: unknown;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
}): Promise<{ text: string }> {
  return await consultMeetingAgent({
    surface: GOOGLE_MEET_CONSULT_SURFACE,
    config: params.fullConfig,
    runtime: params.runtime,
    logger: params.logger,
    agentId: params.config.realtime.agentId,
    toolPolicy: params.config.realtime.toolPolicy,
    meetingSessionId: params.meetingSessionId,
    requesterSessionKey: params.requesterSessionKey,
    args: params.args,
    transcript: params.transcript,
  });
}

export async function handleGoogleMeetRealtimeConsultToolCall(params: {
  strategy: string;
  session: RealtimeVoiceBridgeSession;
  event: RealtimeVoiceToolCallEvent;
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  meetingSessionId: string;
  requesterSessionKey?: string;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  onTalkEvent?: (event: TalkEventInput) => void;
}): Promise<void> {
  await handleMeetingRealtimeConsultToolCall({
    surface: GOOGLE_MEET_CONSULT_SURFACE,
    strategy: params.strategy,
    session: params.session,
    event: params.event,
    config: params.fullConfig,
    runtime: params.runtime,
    logger: params.logger,
    agentId: params.config.realtime.agentId,
    toolPolicy: params.config.realtime.toolPolicy,
    meetingSessionId: params.meetingSessionId,
    requesterSessionKey: params.requesterSessionKey,
    transcript: params.transcript,
    onTalkEvent: params.onTalkEvent,
  });
}
