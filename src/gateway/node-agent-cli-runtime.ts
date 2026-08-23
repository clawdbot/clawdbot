/** In-process Gateway seam for streaming a Claude CLI turn from a paired node. */
import { randomUUID } from "node:crypto";
import type { SystemRunApprovalPlan } from "../infra/exec-approvals.js";
import { NODE_AGENT_CLI_CLAUDE_RUN_COMMAND } from "../infra/node-commands.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "./node-command-policy.js";
import type { NodeInvokeResult } from "./node-registry.js";
import { getFallbackGatewayContext } from "./server-plugin-fallback-context.js";

export async function invokeNodeClaudeCliRun(params: {
  nodeId: string;
  argv: string[];
  stdin: string;
  cwd?: string;
  env?: Record<string, string>;
  clearEnv?: string[];
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
  if (!node || !node.commands.includes(NODE_AGENT_CLI_CLAUDE_RUN_COMMAND)) {
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
    command: NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
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
  return await context.nodeRegistry.invoke({
    nodeId: params.nodeId,
    expectedConnId: node.connId,
    ...(node.pairingGeneration ? { expectedPairingGeneration: node.pairingGeneration } : {}),
    command: NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
    params: {
      argv: params.argv,
      stdin: params.stdin,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.env ? { env: params.env } : {}),
      ...(params.clearEnv ? { clearEnv: params.clearEnv } : {}),
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
