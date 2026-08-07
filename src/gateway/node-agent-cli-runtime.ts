/** In-process Gateway seam for streaming a Claude CLI turn from a paired node. */
import { randomUUID } from "node:crypto";
import type { SystemRunApprovalPlan } from "../infra/exec-approvals.js";
import {
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
  NODE_AGENT_CLI_CLAUDE_RUN_V2_COMMAND,
} from "../infra/node-commands.js";
import { AI_AGENT_ENV_VALUE, canonicalizeAiAgentEnvOverrides } from "../infra/openclaw-exec-env.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "./node-command-policy.js";
import type { NodeInvokeResult } from "./node-registry.js";
import { getFallbackGatewayContext } from "./server-plugin-fallback-context.js";

export type NodeClaudeAiAgentEnv = {
  baseEnv: Record<string, string>;
  configuredEnv: Record<string, string>;
  preparedEnv: Record<string, string>;
  captureEnv: Record<string, string>;
  clearEnv: string[];
  preserveEnv: string[];
  selectedAuth: boolean;
};

type ResolvedAiAgentEnv = { present: false } | { present: true; value: string };

function resolveNodePlatform(platform?: string): NodeJS.Platform {
  const normalized = platform?.trim().toLowerCase();
  return normalized === "win32" || normalized === "windows" ? "win32" : "linux";
}

function hasAiAgentEnvKey(keys: readonly string[], platform: NodeJS.Platform): boolean {
  return keys.some((key) =>
    platform === "win32" ? key.toUpperCase() === "AI_AGENT" : key === "AI_AGENT",
  );
}

function resolveAiAgentEnv(
  env: Record<string, string>,
  platform: NodeJS.Platform,
): ResolvedAiAgentEnv {
  const canonical = canonicalizeAiAgentEnvOverrides(env, platform);
  const value = canonical.AI_AGENT;
  return Object.hasOwn(canonical, "AI_AGENT") && value !== undefined
    ? { present: true, value }
    : { present: false };
}

function resolveNodeAiAgentTransport(params: {
  input: NodeClaudeAiAgentEnv;
  platform: NodeJS.Platform;
}): { env?: string; clear: boolean } {
  const clearRequested = hasAiAgentEnvKey(params.input.clearEnv, params.platform);
  const clearPreserved = hasAiAgentEnvKey(params.input.preserveEnv, params.platform);
  const clear = clearRequested && (!clearPreserved || params.input.selectedAuth);
  const base = resolveAiAgentEnv(params.input.baseEnv, params.platform);
  const configured: ResolvedAiAgentEnv =
    clearRequested && params.input.selectedAuth
      ? { present: false }
      : resolveAiAgentEnv(params.input.configuredEnv, params.platform);
  const prepared = resolveAiAgentEnv(params.input.preparedEnv, params.platform);
  const capture = resolveAiAgentEnv(params.input.captureEnv, params.platform);
  const override: ResolvedAiAgentEnv = capture.present
    ? capture
    : prepared.present
      ? prepared
      : configured;
  const marker: ResolvedAiAgentEnv = override.present
    ? override
    : clear
      ? { present: false }
      : base;
  return {
    ...(marker.present && (marker.value !== AI_AGENT_ENV_VALUE || override.present)
      ? { env: marker.value }
      : {}),
    clear,
  };
}

export async function invokeNodeClaudeCliRun(params: {
  nodeId: string;
  argv: string[];
  stdin: string;
  cwd?: string;
  env?: Record<string, string>;
  clearEnv?: string[];
  aiAgentEnv?: NodeClaudeAiAgentEnv;
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
      ? resolveNodeAiAgentTransport({
          input: params.aiAgentEnv,
          platform: resolveNodePlatform(node.platform),
        })
      : undefined;
  const nodeEnv = {
    ...params.env,
    ...(nodeAiAgent?.env !== undefined ? { AI_AGENT: nodeAiAgent.env } : {}),
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
