import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import {
  buildRealtimeVoiceAgentConsultWorkingResponse,
  consultRealtimeVoiceAgent,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceToolCallEvent,
  type RealtimeVoiceTool,
  type TalkEventInput,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GoogleMeetConfig, GoogleMeetToolPolicy } from "./config.js";

export const GOOGLE_MEET_AGENT_CONSULT_TOOL_NAME = REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME;

const GOOGLE_MEET_CONSULT_SYSTEM_PROMPT = [
  "You are a behind-the-scenes consultant for a live meeting voice agent.",
  "Prioritize a fast, speakable answer over exhaustive investigation.",
  "For tool-backed status checks, prefer one or two bounded read-only queries before answering.",
  "Do not print secret values or dump environment variables; only check whether required configuration is present.",
  "Be accurate, brief, and speakable.",
].join(" ");

export function resolveGoogleMeetRealtimeTools(policy: GoogleMeetToolPolicy): RealtimeVoiceTool[] {
  return resolveRealtimeVoiceAgentConsultTools(policy);
}

export function submitGoogleMeetConsultWorkingResponse(
  session: RealtimeVoiceBridgeSession,
  callId: string,
): void {
  if (!session.bridge.supportsToolResultContinuation) {
    return;
  }
  session.submitToolResult(callId, buildRealtimeVoiceAgentConsultWorkingResponse("participant"), {
    willContinue: true,
  });
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
  const agentId = normalizeAgentId(params.config.realtime.agentId);
  const requesterSessionKey =
    normalizeOptionalString(params.requesterSessionKey) ?? `agent:${agentId}:main`;
  const sessionKey = `agent:${agentId}:subagent:google-meet:${params.meetingSessionId}`;
  return await consultRealtimeVoiceAgent({
    cfg: params.fullConfig,
    agentRuntime: params.runtime.agent,
    logger: params.logger,
    agentId,
    sessionKey,
    messageProvider: "google-meet",
    lane: "google-meet",
    runIdPrefix: `google-meet:${params.meetingSessionId}`,
    spawnedBy: requesterSessionKey,
    contextMode: "fork",
    args: params.args,
    transcript: params.transcript,
    surface: "a private Google Meet",
    userLabel: "Participant",
    assistantLabel: "Agent",
    questionSourceLabel: "participant",
    toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow(params.config.realtime.toolPolicy),
    extraSystemPrompt: GOOGLE_MEET_CONSULT_SYSTEM_PROMPT,
  });
}

export function handleGoogleMeetRealtimeConsultToolCall(params: {
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
}): void {
  const callId = params.event.callId || params.event.itemId;
  if (params.strategy !== "bidi") {
    params.onTalkEvent?.({
      type: "tool.error",
      callId,
      payload: {
        name: params.event.name,
        error: `Tool "${params.event.name}" is only available in bidi realtime strategy`,
      },
      final: true,
    });
    params.session.submitToolResult(callId, {
      error: `Tool "${params.event.name}" is only available in bidi realtime strategy`,
    });
    return;
  }
  if (params.event.name !== GOOGLE_MEET_AGENT_CONSULT_TOOL_NAME) {
    params.onTalkEvent?.({
      type: "tool.error",
      callId,
      payload: { name: params.event.name, error: `Tool "${params.event.name}" not available` },
      final: true,
    });
    params.session.submitToolResult(callId, {
      error: `Tool "${params.event.name}" not available`,
    });
    return;
  }
  params.onTalkEvent?.({
    type: "tool.progress",
    callId,
    payload: { name: params.event.name, status: "working" },
  });
  submitGoogleMeetConsultWorkingResponse(params.session, callId);
  void consultOpenClawAgentForGoogleMeet({
    config: params.config,
    fullConfig: params.fullConfig,
    runtime: params.runtime,
    logger: params.logger,
    meetingSessionId: params.meetingSessionId,
    requesterSessionKey: params.requesterSessionKey,
    args: params.event.args,
    transcript: params.transcript,
  })
    .then((result) => {
      params.onTalkEvent?.({
        type: "tool.result",
        callId,
        payload: { name: params.event.name, result },
        final: true,
      });
      params.session.submitToolResult(callId, result);
    })
    .catch((error: Error) => {
      params.onTalkEvent?.({
        type: "tool.error",
        callId,
        payload: { name: params.event.name, error: formatErrorMessage(error) },
        final: true,
      });
      params.session.submitToolResult(callId, {
        error: formatErrorMessage(error),
      });
    });
}
