// Google Meet plugin module implements agent consult behavior.
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

async function submitGoogleMeetConsultWorkingResponse(
  session: RealtimeVoiceBridgeSession,
  callId: string,
): Promise<void> {
  if (!session.bridge.supportsToolResultContinuation) {
    return;
  }
  await session.submitToolResult(
    callId,
    buildRealtimeVoiceAgentConsultWorkingResponse("participant"),
    {
      willContinue: true,
    },
  );
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
  const callId = params.event.callId || params.event.itemId;
  if (params.strategy !== "bidi") {
    const error = `Tool "${params.event.name}" is only available in bidi realtime strategy`;
    await params.session.submitToolResult(callId, { error });
    params.onTalkEvent?.({
      type: "tool.error",
      callId,
      payload: {
        name: params.event.name,
        error,
      },
      final: true,
    });
    return;
  }
  if (params.event.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
    const error = `Tool "${params.event.name}" not available`;
    await params.session.submitToolResult(callId, { error });
    params.onTalkEvent?.({
      type: "tool.error",
      callId,
      payload: { name: params.event.name, error },
      final: true,
    });
    return;
  }
  await submitGoogleMeetConsultWorkingResponse(params.session, callId);
  params.onTalkEvent?.({
    type: "tool.progress",
    callId,
    payload: { name: params.event.name, status: "working" },
  });
  let result: { text: string };
  try {
    result = await consultOpenClawAgentForGoogleMeet({
      config: params.config,
      fullConfig: params.fullConfig,
      runtime: params.runtime,
      logger: params.logger,
      meetingSessionId: params.meetingSessionId,
      requesterSessionKey: params.requesterSessionKey,
      args: params.event.args,
      transcript: params.transcript,
    });
  } catch (error) {
    const message = formatErrorMessage(error);
    await params.session.submitToolResult(callId, { error: message });
    params.onTalkEvent?.({
      type: "tool.error",
      callId,
      payload: { name: params.event.name, error: message },
      final: true,
    });
    return;
  }
  await params.session.submitToolResult(callId, result);
  params.onTalkEvent?.({
    type: "tool.result",
    callId,
    payload: { name: params.event.name, result },
    final: true,
  });
}
