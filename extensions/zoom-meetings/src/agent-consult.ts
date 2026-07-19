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
  RealtimeVoiceTool,
  RealtimeVoiceToolCallEvent,
  TalkEventInput,
} from "openclaw/plugin-sdk/realtime-voice";
import type { ZoomMeetingsConfig, ZoomMeetingsToolPolicy } from "./config.js";

const ZOOM_MEETINGS_CONSULT_SURFACE: MeetingAgentConsultSurface = {
  id: "zoom-meetings",
  provider: "zoom-meetings",
  lane: "zoom-meetings",
  surface: "a private Zoom meeting",
  userLabel: "Participant",
  assistantLabel: "Agent",
  questionSourceLabel: "participant",
  workingResponseLabel: "participant",
  extraSystemPrompt: [
    "You are a behind-the-scenes consultant for a live meeting voice agent.",
    "Prioritize a fast, speakable answer over exhaustive investigation.",
    "Use only bounded, task-relevant tool calls.",
    "Never print secrets or dump environment variables.",
    "Be accurate, brief, and speakable.",
  ].join(" "),
};

export function resolveZoomMeetingsRealtimeTools(
  policy: ZoomMeetingsToolPolicy,
): RealtimeVoiceTool[] {
  return resolveMeetingRealtimeTools(policy);
}

export async function consultOpenClawAgentForZoomMeeting(params: {
  config: ZoomMeetingsConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  meetingSessionId: string;
  requesterSessionKey?: string;
  args: unknown;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
}): Promise<{ text: string }> {
  return await consultMeetingAgent({
    surface: ZOOM_MEETINGS_CONSULT_SURFACE,
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

export async function handleZoomMeetingsRealtimeConsultToolCall(params: {
  strategy: string;
  session: RealtimeVoiceBridgeSession;
  event: RealtimeVoiceToolCallEvent;
  config: ZoomMeetingsConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  meetingSessionId: string;
  requesterSessionKey?: string;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  onTalkEvent?: (event: TalkEventInput) => void;
}): Promise<void> {
  await handleMeetingRealtimeConsultToolCall({
    surface: ZOOM_MEETINGS_CONSULT_SURFACE,
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
