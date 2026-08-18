/**
 * Nested agent-step executor.
 *
 * Sends annotated inter-session messages through in-process or Gateway execution and reads the assistant reply.
 */
import crypto from "node:crypto";
import type { AgentRuntimeSessionHandoffContext } from "../../gateway/agent-runtime-session-handoff.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { retireSessionMcpRuntimeForSessionKey } from "../agent-bundle-mcp-tools.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import { waitForAgentRunAndReadUpdatedAssistantReply } from "../run-wait.js";
import type { GatewayToolCallerIdentity } from "./gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import { callSessionHandoffAgent } from "./session-handoff-agent-call.js";

type GatewayCaller = AgentToolGatewayRequestCaller;
/** Sends one annotated message to a target session and returns the resulting assistant text. */
export async function runAgentStep(params: {
  agentId?: string;
  sessionKey: string;
  message: string;
  extraSystemPrompt: string;
  timeoutMs: number;
  channel?: string;
  lane?: string;
  transcriptMessage?: string;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  callGateway?: GatewayCaller;
  authority?: GatewayToolCallerIdentity;
  handoffContext?: AgentRuntimeSessionHandoffContext;
}): Promise<string | undefined> {
  const stepIdem = crypto.randomUUID();
  const inputProvenance = {
    kind: "inter_session" as const,
    sourceSessionKey: params.sourceSessionKey,
    sourceChannel: params.sourceChannel,
    sourceTool: params.sourceTool ?? "sessions_send",
  };
  // Mark inter-session prompts so downstream transcripts can distinguish tool-routed text.
  const message = annotateInterSessionPromptText(params.message, inputProvenance);
  const lane = params.lane ?? resolveNestedAgentLaneForSession(params.sessionKey);
  const channel = params.channel ?? INTERNAL_MESSAGE_CHANNEL;
  const gatewayCall = params.callGateway ?? callAgentToolGatewayRequest;
  if (params.transcriptMessage !== undefined && !params.handoffContext) {
    throw new Error("private transcript agent step requires session handoff authority");
  }
  const handoffContext = params.handoffContext
    ? {
        ...params.handoffContext,
        ...(params.transcriptMessage !== undefined
          ? { transcriptMessage: params.transcriptMessage }
          : {}),
      }
    : undefined;
  const request = {
    method: "agent",
    params: {
      message,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      sessionKey: params.sessionKey,
      idempotencyKey: stepIdem,
      deliver: false,
      sourceReplyDeliveryMode: "message_tool_only",
      channel,
      lane,
      extraSystemPrompt: params.extraSystemPrompt,
      inputProvenance,
    },
    timeoutMs: 10_000,
  } as const;
  const response = handoffContext
    ? params.authority
      ? await callSessionHandoffAgent<{ runId?: string }>({
          request,
          authority: params.authority,
          context: handoffContext,
        })
      : (() => {
          throw new Error("session handoff step requires trusted caller identity");
        })()
    : await gatewayCall(request);

  const stepRunId = typeof response?.runId === "string" && response.runId ? response.runId : "";
  const resolvedRunId = stepRunId || stepIdem;
  // Gateway agent calls can return before the assistant reply is persisted.
  const result = await waitForAgentRunAndReadUpdatedAssistantReply({
    runId: resolvedRunId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    timeoutMs: Math.min(params.timeoutMs, 60_000),
    callGateway: gatewayCall,
  });
  if (result.status === "ok" || result.status === "error") {
    await retireSessionMcpRuntimeForSessionKey({
      sessionKey: params.sessionKey,
      reason: "nested-agent-step-complete",
    });
  }
  if (result.status !== "ok") {
    return undefined;
  }
  return result.replyText;
}
