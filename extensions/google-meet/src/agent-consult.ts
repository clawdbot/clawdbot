import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import {
  consultRealtimeVoiceAgent,
  REALTIME_VOICE_AGENT_CONSULT_TOOL,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  type RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import type { GoogleMeetConfig, GoogleMeetToolPolicy } from "./config.js";

export const GOOGLE_MEET_AGENT_CONSULT_TOOL_NAME = REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME;
export const GOOGLE_MEET_AGENT_CONSULT_TOOL = REALTIME_VOICE_AGENT_CONSULT_TOOL;

export function resolveGoogleMeetRealtimeTools(policy: GoogleMeetToolPolicy): RealtimeVoiceTool[] {
  return resolveRealtimeVoiceAgentConsultTools(policy);
}

export async function consultOpenClawAgentForGoogleMeet(params: {
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  meetingSessionId: string;
  args: unknown;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
}): Promise<{ text: string }> {
  return await consultRealtimeVoiceAgent({
    cfg: params.fullConfig,
    agentRuntime: params.runtime.agent,
    logger: params.logger,
    sessionKey: `google-meet:${params.meetingSessionId}`,
    messageProvider: "google-meet",
    lane: "google-meet",
    runIdPrefix: `google-meet:${params.meetingSessionId}`,
    args: params.args,
    transcript: params.transcript,
    surface: "a private Google Meet",
    userLabel: "Participant",
    assistantLabel: "Agent",
    questionSourceLabel: "participant",
    toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow(params.config.realtime.toolPolicy),
    extraSystemPrompt:
      "You are a behind-the-scenes consultant for a live meeting voice agent. Be accurate, brief, and speakable.",
  });
}
