/** In-process Gateway seam for streaming a Claude CLI turn from a paired node. */
import { randomUUID } from "node:crypto";
import type { SystemRunApprovalPlan } from "../infra/exec-approvals.js";
import {
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
  NODE_AGENT_CLI_CLAUDE_RUN_V2_COMMAND,
} from "../infra/node-commands.js";
import { type AiAgentEnvPlan, resolveAiAgentEnvPlan } from "../infra/openclaw-exec-env.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "./node-command-policy.js";
import type { NodeInvokeResult } from "./node-registry.js";
import { getFallbackGatewayContext } from "./server-plugin-fallback-context.js";

function resolveNodePlatform(platform?: string): NodeJS.Platform {
  const normalized = platform?.trim().toLowerCase();
  return normalized === "win32" || normalized === "windows" ? "win32" : "linux";
}

export async function invokeNodeClaudeCliRun(params: {
  nodeId: string;
  argv: string[];
  stdin: string;
  cwd?: string;
  env?: Record<string, string>;
  clearEnv?: string[];
  aiAgentEnv?: AiAgentEnvPlan;
  systemPrompt?: string;
  agentId?: string;
  sessionKey?: string;
  approvalDecision?: "allow-once" | "allow-always";
  systemRunPlan?: SystemRunApprovalPlan;
  timeoutMs: number;
  idleTimeoutMs: number;
  onProgress: (chunk: string) => void;
  signal?: AbortSignal;
}): Promise<NodeInvokeResult> {
  const context = getFallbackGatewayContext();
  if (!context) {
    return {
      ok: false,
      error: { code: "UNAVAILABLE", message: "Gateway node runtime unavailable" },
    };
  }
  const node = context.nodeRegistry.get(params.nodeId);
  // v2 advertises marker support. Keep v1 payloads unchanged for rolling
  // upgrades because older strict decoders reject unknown environment keys.
  const supportsAiAgentEnv = node?.commands.includes(NODE_AGENT_CLI_CLAUDE_RUN_V2_COMMAND) === true;
  const command = supportsAiAgentEnv
    ? NODE_AGENT_CLI_CLAUDE_RUN_V2_COMMAND
    : NODE_AGENT_CLI_CLAUDE_RUN_COMMAND;
  if (!node || !node.commands.includes(command)) {
    return {
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "paired node does not advertise Claude CLI agent runs",
      },
    };
  }
  const allowlist = resolveNodeCommandAllowlist(context.getRuntimeConfig(), {
    ...node,
    approvedCommands: node.commands,
  });
  const allowed = isNodeCommandAllowed({
    command,
    declaredCommands: node.commands,
    allowlist,
  });
  if (!allowed.ok) {
    return {
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        message: `paired-node Claude CLI agent runs are blocked by node command policy (${allowed.reason})`,
      },
    };
  }
  const nodeAiAgent =
    params.aiAgentEnv && supportsAiAgentEnv
      ? resolveAiAgentEnvPlan(params.aiAgentEnv, resolveNodePlatform(node.platform))
      : undefined;
  const nodeEnv = {
    ...params.env,
    ...(nodeAiAgent?.value !== undefined ? { AI_AGENT: nodeAiAgent.value } : {}),
  };
  const nodeClearEnv = new Set(params.clearEnv);
  if (nodeAiAgent?.clear) {
    nodeClearEnv.add("AI_AGENT");
  }
  return await context.nodeRegistry.invoke({
    nodeId: params.nodeId,
    expectedConnId: node.connId,
    ...(node.pairingGeneration ? { expectedPairingGeneration: node.pairingGeneration } : {}),
    command,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    params: {
      argv: params.argv,
      stdin: params.stdin,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(Object.keys(nodeEnv).length > 0 ? { env: nodeEnv } : {}),
      ...(nodeClearEnv.size > 0 ? { clearEnv: [...nodeClearEnv] } : {}),
      ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.approvalDecision ? { approvalDecision: params.approvalDecision } : {}),
      ...(params.systemRunPlan ? { systemRunPlan: params.systemRunPlan } : {}),
      idleTimeoutMs: params.idleTimeoutMs,
      timeoutMs: params.timeoutMs,
    },
    timeoutMs: params.timeoutMs,
    idleTimeoutMs: params.idleTimeoutMs,
    idempotencyKey: randomUUID(),
    onProgress: params.onProgress,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}
