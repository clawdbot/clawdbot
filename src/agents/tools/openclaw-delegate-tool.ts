/** Regular-agent client for the OpenClaw system agent. */
import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";
import { SYSTEM_AGENT_ID } from "../../system-agent/agent-id.js";
import { resolveExecDefaults } from "../exec-defaults.js";
import type { OpenClawToolsOptions } from "../openclaw-tools.types.js";
import { jsonResult, readToolStringParam, type AnyAgentTool } from "./common.js";
import { wrapToolWithGatewayCallerIdentity } from "./gateway-caller-context.js";
import { callInProcessGatewayTool } from "./in-process-gateway.js";

const OpenClawDelegateSchema = Type.Object({
  message: Type.String({ description: "What system must do." }),
  sessionId: Type.Optional(Type.String({ description: "Continue prior OpenClaw talk." })),
});

const OpenClawDelegateOutputSchema = Type.Object(
  {
    reply: Type.String(),
    action: Type.Optional(Type.String()),
    needsApproval: Type.Optional(Type.Literal(true)),
    proposalId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

type OpenClawDelegateResult = {
  sessionId: string;
  reply: string;
  action?: string;
  needsApproval?: boolean;
  proposalId?: string;
};

function stableDelegationSessionId(sessionKey: string | undefined, agentId: string): string {
  return sessionKey?.trim()
    ? `delegate-${createHash("sha256")
        .update(`${agentId}\0${sessionKey.trim()}`)
        .digest("hex")
        .slice(0, 32)}`
    : `delegate-${randomUUID()}`;
}

export function createOpenClawDelegateToolsForRun(
  options: Pick<
    OpenClawToolsOptions,
    | "sandboxed"
    | "runSessionKey"
    | "agentSessionKey"
    | "agentChannel"
    | "currentMessagingTarget"
    | "currentChannelId"
    | "agentTo"
    | "agentAccountId"
    | "currentThreadTs"
    | "agentThreadId"
    | "config"
    | "execSession"
    | "execOverrides"
    | "fsPolicy"
  > & { sessionAgentId: string },
): AnyAgentTool[] {
  if (options.sandboxed || options.sessionAgentId === SYSTEM_AGENT_ID) {
    return [];
  }
  const sessionKey = options.runSessionKey ?? options.agentSessionKey;
  const defaultSessionId = stableDelegationSessionId(sessionKey, options.sessionAgentId);
  const execPolicy = resolveExecDefaults({
    cfg: options.config,
    agentId: options.sessionAgentId,
    sessionKey: options.agentSessionKey ?? sessionKey,
    sessionEntry: options.execSession,
    execOverrides: options.execOverrides,
  });
  const fullPermission =
    options.fsPolicy?.workspaceOnly !== true &&
    execPolicy.effectiveHost !== "sandbox" &&
    execPolicy.security === "full" &&
    execPolicy.ask === "off";
  const turnSourceTo =
    options.currentMessagingTarget ?? options.currentChannelId ?? options.agentTo;
  const turnSourceThreadId = options.currentThreadTs ?? options.agentThreadId;
  const tool: AnyAgentTool = {
    name: "openclaw",
    label: "OpenClaw",
    description:
      "Ask system expert. Gateway restart, config, channels, plugins, agents, models/providers, updates. " +
      (fullPermission
        ? "Full Access applies permitted changes without asking for approval."
        : "Changes need human approval."),
    parameters: OpenClawDelegateSchema,
    outputSchema: OpenClawDelegateOutputSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const message = readToolStringParam(params, "message", { required: true });
      const sessionId = readToolStringParam(params, "sessionId") ?? defaultSessionId;
      const result = await callInProcessGatewayTool<OpenClawDelegateResult>("openclaw.chat", {
        sessionId,
        message,
        delegation: {
          agentId: options.sessionAgentId,
          ...(sessionKey ? { sessionKey } : {}),
          ...(options.agentChannel ? { turnSourceChannel: options.agentChannel } : {}),
          ...(turnSourceTo ? { turnSourceTo } : {}),
          ...(options.agentAccountId ? { turnSourceAccountId: options.agentAccountId } : {}),
          ...(turnSourceThreadId !== undefined ? { turnSourceThreadId } : {}),
        },
      });
      return jsonResult({
        reply: result.reply,
        ...(result.action && result.action !== "none" ? { action: result.action } : {}),
        ...(result.needsApproval ? { needsApproval: true } : {}),
        ...(result.proposalId ? { proposalId: result.proposalId } : {}),
      });
    },
  };
  // Keep permission authority out of model-authored RPC data and scoped to this tool call.
  return [
    wrapToolWithGatewayCallerIdentity(
      tool,
      sessionKey ? { agentId: options.sessionAgentId, sessionKey, fullPermission } : undefined,
    ),
  ];
}
