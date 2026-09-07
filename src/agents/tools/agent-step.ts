/**
 * Nested agent-step executor.
 *
 * Sends annotated inter-session messages through in-process or Gateway execution and reads the assistant reply.
 */
import crypto from "node:crypto";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { recordSessionParticipantBestEffort } from "../../sessions/session-participant-recording.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import { waitForAgentRunReply } from "../run-wait.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";

type GatewayCaller = AgentToolGatewayRequestCaller;
type AgentCommandRunner = typeof import("../../commands/agent.js").agentCommandFromIngress;

const defaultAgentStepDeps = {
  agentCommandFromIngress: (async (...args) => {
    const { agentCommandFromIngress } = await import("../../commands/agent.js");
    return await agentCommandFromIngress(...args);
  }) as AgentCommandRunner,
};

let agentStepDeps: {
  agentCommandFromIngress: AgentCommandRunner;
} = defaultAgentStepDeps;

function extractAgentCommandReply(
  result: Awaited<ReturnType<AgentCommandRunner>>,
): string | undefined {
  const error = result?.meta.error;
  // Plain incomplete-turn output is a control failure; trusted terminal tool presentations remain deliverable.
  if (error?.kind === "incomplete_turn" && error.terminalPresentation !== true) {
    return undefined;
  }
  const texts = result?.payloads
    ?.map((payload) => payload.text)
    .filter((text): text is string => Boolean(text?.trim()));
  return texts?.length ? texts.join("\n\n") : undefined;
}

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
  sourceAgentId?: string;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  callGateway?: GatewayCaller;
}): Promise<string | undefined> {
  const promptedAt = Date.now();
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
  if (params.transcriptMessage !== undefined) {
    // Intentional direct in-process exception: the public agent schema rejects transcriptMessage.
    // Keep announce bookkeeping off the wire without expanding the model-authored RPC surface.
    const result = await agentStepDeps.agentCommandFromIngress({
      message,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      transcriptMessage: params.transcriptMessage,
      sessionKey: params.sessionKey,
      deliver: false,
      sourceReplyDeliveryMode: "message_tool_only",
      channel,
      lane,
      runId: stepIdem,
      extraSystemPrompt: params.extraSystemPrompt,
      inputProvenance,
      allowModelOverride: false,
    });
    return extractAgentCommandReply(result);
  }
  const response = await gatewayCall({
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
  });

  if (params.sourceAgentId && params.agentId) {
    recordSessionParticipantBestEffort({
      identity: { type: "agent", id: params.sourceAgentId },
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
        agentId: params.agentId,
      }),
      promptedAt,
    });
  }

  const stepRunId = typeof response?.runId === "string" && response.runId ? response.runId : "";
  const resolvedRunId = stepRunId || stepIdem;
  const result = await waitForAgentRunReply({
    runId: resolvedRunId,
    timeoutMs: Math.min(params.timeoutMs, 60_000),
    callGateway: gatewayCall,
  });
  if (result.status !== "ok") {
    return undefined;
  }
  return result.replyText;
}

/** Test-only dependency overrides for gateway and in-process command execution. */
const testing = {
  setDepsForTest(
    overrides?: Partial<{
      agentCommandFromIngress: AgentCommandRunner;
    }>,
  ) {
    agentStepDeps = overrides
      ? {
          ...defaultAgentStepDeps,
          ...overrides,
        }
      : defaultAgentStepDeps;
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.agentStepTestApi")] = {
    testing,
  };
}
