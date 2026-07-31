import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { consultRealtimeVoiceAgent } from "../talk/agent-consult-runtime.js";
import {
  buildRealtimeVoiceAgentConsultWorkingResponse,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  type RealtimeVoiceAgentConsultToolPolicy,
} from "../talk/agent-consult-tool.js";
import type { RealtimeVoiceTool, RealtimeVoiceToolCallEvent } from "../talk/provider-types.js";
import type { RealtimeVoiceBridgeSession } from "../talk/session-runtime.js";
import type { TalkEventInput } from "../talk/talk-events.js";
import type {
  MeetingAgentConsultSurface,
  MeetingPlatformRuntimeMetadata,
} from "./platform-adapter-contract.js";
import type {
  MeetingAgentConsultParams,
  MeetingRealtimeToolCallParams,
  MeetingRuntimePlatform,
} from "./realtime-engine.js";

function resolveMeetingRealtimeTools(
  policy: RealtimeVoiceAgentConsultToolPolicy,
): RealtimeVoiceTool[] {
  return resolveRealtimeVoiceAgentConsultTools(policy);
}

function resolveMeetingAgentConsultSurface(
  platform: MeetingPlatformRuntimeMetadata,
): MeetingAgentConsultSurface {
  return {
    id: platform.id,
    provider: platform.id,
    lane: platform.id,
    ...platform.agentConsult,
  };
}

export function createMeetingRealtimeEngineBindings(params: {
  platform: MeetingPlatformRuntimeMetadata;
  config: {
    realtime: {
      agentId?: string;
      toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
    };
  };
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
}): {
  platform: MeetingRuntimePlatform;
  consultAgent: (consult: MeetingAgentConsultParams) => Promise<{ text: string }>;
  tools: RealtimeVoiceTool[];
  handleToolCall: (call: MeetingRealtimeToolCallParams) => Promise<void>;
} {
  const surface = resolveMeetingAgentConsultSurface(params.platform);
  return {
    platform: {
      displayName: params.platform.displayName,
      logScope: params.platform.logScope,
      sessionIdPrefix: params.platform.id,
    },
    consultAgent: async (consult) =>
      await consultMeetingAgent({
        surface,
        config: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        agentId: params.config.realtime.agentId,
        toolPolicy: params.config.realtime.toolPolicy,
        ...consult,
      }),
    tools: resolveMeetingRealtimeTools(params.config.realtime.toolPolicy),
    handleToolCall: async (call) =>
      await handleMeetingRealtimeConsultToolCall({
        surface,
        config: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        agentId: params.config.realtime.agentId,
        toolPolicy: params.config.realtime.toolPolicy,
        ...call,
      }),
  };
}

async function submitMeetingConsultWorkingResponse(params: {
  session: RealtimeVoiceBridgeSession;
  callId: string;
  label: string;
}): Promise<void> {
  if (!params.session.bridge.supportsToolResultContinuation) {
    return;
  }
  await params.session.submitToolResult(
    params.callId,
    buildRealtimeVoiceAgentConsultWorkingResponse(params.label),
    { willContinue: true },
  );
}

async function consultMeetingAgent(params: {
  surface: MeetingAgentConsultSurface;
  config: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  agentId?: string;
  toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
  meetingSessionId: string;
  requesterSessionKey?: string;
  args: unknown;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
}): Promise<{ text: string }> {
  const agentId = params.agentId
    ? normalizeAgentId(params.agentId)
    : resolveDefaultAgentId(params.config);
  const requesterSessionKey =
    normalizeOptionalString(params.requesterSessionKey) ?? `agent:${agentId}:main`;
  const sessionKey = `agent:${agentId}:subagent:${params.surface.id}:${params.meetingSessionId}`;
  return await consultRealtimeVoiceAgent({
    cfg: params.config,
    agentRuntime: params.runtime.agent,
    logger: params.logger,
    agentId,
    sessionKey,
    messageProvider: params.surface.provider,
    lane: params.surface.lane,
    runIdPrefix: `${params.surface.id}:${params.meetingSessionId}`,
    spawnedBy: requesterSessionKey,
    contextMode: "fork",
    args: params.args,
    transcript: params.transcript,
    surface: params.surface.surface,
    userLabel: params.surface.userLabel,
    assistantLabel: params.surface.assistantLabel,
    questionSourceLabel: params.surface.questionSourceLabel,
    toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow(params.toolPolicy),
    extraSystemPrompt: params.surface.extraSystemPrompt,
  });
}

async function handleMeetingRealtimeConsultToolCall(params: {
  surface: MeetingAgentConsultSurface;
  strategy: string;
  session: RealtimeVoiceBridgeSession;
  event: RealtimeVoiceToolCallEvent;
  config: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  agentId?: string;
  toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
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
      payload: { name: params.event.name, error },
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
  await submitMeetingConsultWorkingResponse({
    session: params.session,
    callId,
    label: params.surface.workingResponseLabel,
  });
  params.onTalkEvent?.({
    type: "tool.progress",
    callId,
    payload: { name: params.event.name, status: "working" },
  });
  let result: { text: string };
  try {
    result = await consultMeetingAgent({
      surface: params.surface,
      config: params.config,
      runtime: params.runtime,
      logger: params.logger,
      agentId: params.agentId,
      toolPolicy: params.toolPolicy,
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
