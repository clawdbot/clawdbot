import crypto from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  describeInterpreterInlineEval,
  type InterpreterInlineEvalHit,
} from "../infra/command-analysis/inline-eval.js";
import { detectPolicyInlineEval } from "../infra/command-analysis/policy.js";
import {
  type ExecApprovalsFile,
  type ExecAsk,
  type ExecSecurity,
  type SystemRunApprovalPlan,
  evaluateShellAllowlist,
  hasDurableExecApproval,
  resolveExecApprovalsFromFile,
} from "../infra/exec-approvals.js";
import { buildNodeShellCommand } from "../infra/node-shell.js";
import { parsePreparedSystemRunPayload } from "../infra/system-run-approval-context.js";
import { formatExecCommand, resolveSystemRunCommandRequest } from "../infra/system-run-command.js";
import { normalizeNullableString } from "../shared/string-coerce.js";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";
import { renderExecOutputText } from "./bash-tools.exec-output.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import { callGatewayTool } from "./tools/gateway.js";
import { listNodes, resolveNodeIdFromList } from "./tools/nodes-utils.js";

type NodeExecutionTarget = {
  nodeId: string;
  platform?: string | null;
  argv: string[];
  env: Record<string, string> | undefined;
  invokeTimeoutMs: number;
  runTimeoutSec: number;
  supportsSystemRunPrepare: boolean;
};

type PreparedNodeRun = {
  plan: SystemRunApprovalPlan;
  argv: string[];
  rawCommand: string;
  cwd: string | undefined;
  agentId: string | undefined;
  sessionKey: string | undefined;
};

type NodeApprovalAnalysis = {
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  durableApprovalSatisfied: boolean;
  inlineEvalHit: InterpreterInlineEvalHit | null;
};

export function shouldSkipNodeApprovalPrepare(params: {
  hostSecurity: ExecSecurity;
  hostAsk: ExecAsk;
  strictInlineEval?: boolean;
}): boolean {
  return (
    params.hostSecurity === "full" && params.hostAsk === "off" && params.strictInlineEval !== true
  );
}

export function formatNodeRunToolResult(params: {
  raw: unknown;
  startedAt: number;
  cwd: string | undefined;
}): AgentToolResult<ExecToolDetails> {
  const payload =
    params.raw && typeof params.raw === "object"
      ? (params.raw as { payload?: unknown }).payload
      : undefined;
  const payloadObj =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const stdout = typeof payloadObj.stdout === "string" ? payloadObj.stdout : "";
  const stderr = typeof payloadObj.stderr === "string" ? payloadObj.stderr : "";
  const errorText = typeof payloadObj.error === "string" ? payloadObj.error : "";
  const success = typeof payloadObj.success === "boolean" ? payloadObj.success : false;
  const exitCode = typeof payloadObj.exitCode === "number" ? payloadObj.exitCode : null;
  return {
    content: [
      {
        type: "text",
        text: renderExecOutputText(stdout || stderr || errorText),
      },
    ],
    details: {
      status: success ? "completed" : "failed",
      exitCode,
      durationMs: Date.now() - params.startedAt,
      aggregated: [stdout, stderr, errorText].filter(Boolean).join("\n"),
      cwd: params.cwd,
    } satisfies ExecToolDetails,
  };
}

export async function resolveNodeExecutionTarget(
  params: ExecuteNodeHostCommandParams,
): Promise<NodeExecutionTarget> {
  if (params.boundNode && params.requestedNode && params.boundNode !== params.requestedNode) {
    throw new Error(`exec node not allowed (bound to ${params.boundNode})`);
  }
  const nodeQuery = params.boundNode || params.requestedNode;
  const nodes = await listNodes({});
  if (nodes.length === 0) {
    throw new Error(
      "exec host=node requires a paired node (none available). This requires a companion app or node host.",
    );
  }
  let nodeId: string;
  try {
    nodeId = resolveNodeIdFromList(nodes, nodeQuery, !nodeQuery);
  } catch (err) {
    if (!nodeQuery && String(err).includes("node required")) {
      throw new Error(
        "exec host=node requires a node id when multiple nodes are available (set tools.exec.node or exec.node).",
        { cause: err },
      );
    }
    throw err;
  }
  const nodeInfo = nodes.find((entry) => entry.nodeId === nodeId);
  if (nodeInfo?.connected === false) {
    throw new Error(
      `exec host=node requires a connected node (${nodeId} is currently disconnected). Start or reconnect the companion app or node host, or select a connected node.`,
    );
  }
  const declaredCommands = Array.isArray(nodeInfo?.commands) ? nodeInfo.commands : [];
  const supportsSystemRun = declaredCommands.includes("system.run");
  if (!supportsSystemRun) {
    throw new Error(
      "exec host=node requires a node that supports system.run (companion app or node host).",
    );
  }

  const runTimeoutSec =
    typeof params.timeoutSec === "number" ? params.timeoutSec : params.defaultTimeoutSec;
  const invokeBaseTimeoutSec = runTimeoutSec > 0 ? runTimeoutSec : params.defaultTimeoutSec;
  return {
    nodeId,
    platform: nodeInfo?.platform,
    argv: buildNodeShellCommand(params.command, nodeInfo?.platform),
    env: params.requestedEnv ? { ...params.requestedEnv } : undefined,
    invokeTimeoutMs: Math.max(10_000, invokeBaseTimeoutSec * 1000 + 5_000),
    runTimeoutSec,
    supportsSystemRunPrepare: declaredCommands.includes("system.run.prepare"),
  };
}

export function buildNodeSystemRunInvoke(params: {
  target: NodeExecutionTarget;
  command: string[];
  rawCommand: string;
  cwd: string | undefined;
  agentId: string | undefined;
  sessionKey: string | undefined;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  approved?: boolean;
  approvalDecision?: "allow-once" | "allow-always" | null;
  runId?: string;
  suppressNotifyOnExit?: boolean;
  notifyOnExit?: boolean;
  systemRunPlan?: SystemRunApprovalPlan;
}): Record<string, unknown> {
  const timeoutMs =
    params.target.runTimeoutSec > 0 ? Math.floor(params.target.runTimeoutSec * 1000) : 0;
  return {
    nodeId: params.target.nodeId,
    command: "system.run",
    params: {
      command: params.command,
      rawCommand: params.rawCommand,
      ...(params.systemRunPlan ? { systemRunPlan: params.systemRunPlan } : {}),
      ...(params.cwd != null ? { cwd: params.cwd } : {}),
      env: params.target.env,
      timeoutMs,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      ...(params.turnSourceChannel != null ? { turnSourceChannel: params.turnSourceChannel } : {}),
      ...(params.turnSourceTo != null ? { turnSourceTo: params.turnSourceTo } : {}),
      ...(params.turnSourceAccountId != null
        ? { turnSourceAccountId: params.turnSourceAccountId }
        : {}),
      ...(params.turnSourceThreadId != null
        ? { turnSourceThreadId: params.turnSourceThreadId }
        : {}),
      approved: params.approved,
      approvalDecision: params.approvalDecision ?? undefined,
      runId: params.runId ?? undefined,
      suppressNotifyOnExit:
        params.suppressNotifyOnExit === true || params.notifyOnExit === false ? true : undefined,
    },
    idempotencyKey: crypto.randomUUID(),
  };
}

export async function invokeNodeSystemRunDirect(params: {
  request: ExecuteNodeHostCommandParams;
  target: NodeExecutionTarget;
}): Promise<AgentToolResult<ExecToolDetails>> {
  const startedAt = Date.now();
  const raw = await callGatewayTool(
    "node.invoke",
    { timeoutMs: params.target.invokeTimeoutMs },
    buildNodeSystemRunInvoke({
      target: params.target,
      command: params.target.argv,
      rawCommand: params.request.command,
      cwd: params.request.workdir,
      agentId: params.request.agentId,
      sessionKey: params.request.sessionKey,
      notifyOnExit: params.request.notifyOnExit,
    }),
  );
  return formatNodeRunToolResult({ raw, startedAt, cwd: params.request.workdir });
}

export async function prepareNodeSystemRun(params: {
  request: ExecuteNodeHostCommandParams;
  target: NodeExecutionTarget;
}): Promise<PreparedNodeRun> {
  if (!params.target.supportsSystemRunPrepare) {
    return buildLocalPreparedNodeRun(params);
  }

  const prepareRaw = await callGatewayTool(
    "node.invoke",
    { timeoutMs: 15_000 },
    {
      nodeId: params.target.nodeId,
      command: "system.run.prepare",
      params: {
        command: params.target.argv,
        rawCommand: params.request.command,
        ...(params.request.workdir != null ? { cwd: params.request.workdir } : {}),
        agentId: params.request.agentId,
        sessionKey: params.request.sessionKey,
      },
      idempotencyKey: crypto.randomUUID(),
    },
  );
  const prepared = parsePreparedSystemRunPayload(prepareRaw?.payload);
  if (!prepared) {
    throw new Error("invalid system.run.prepare response");
  }
  return {
    plan: prepared.plan,
    argv: prepared.plan.argv,
    rawCommand: prepared.plan.commandText,
    cwd: prepared.plan.cwd ?? params.request.workdir,
    agentId: prepared.plan.agentId ?? params.request.agentId,
    sessionKey: prepared.plan.sessionKey ?? params.request.sessionKey,
  };
}

function buildLocalPreparedNodeRun(params: {
  request: ExecuteNodeHostCommandParams;
  target: NodeExecutionTarget;
}): PreparedNodeRun {
  const rawCommand = formatExecCommand(params.target.argv);
  const command = resolveSystemRunCommandRequest({
    command: params.target.argv,
    rawCommand,
  });
  if (!command.ok) {
    throw new Error(command.message);
  }
  if (command.argv.length === 0) {
    throw new Error("command required");
  }
  const commandText = formatExecCommand(command.argv);
  const previewText = params.request.command.trim() || command.previewText?.trim();
  const commandPreview = previewText && previewText !== commandText ? previewText : null;
  const plan = {
    argv: [...command.argv],
    cwd: normalizeNullableString(params.request.workdir),
    commandText,
    commandPreview,
    agentId: normalizeNullableString(params.request.agentId),
    sessionKey: normalizeNullableString(params.request.sessionKey),
  } satisfies SystemRunApprovalPlan;
  return {
    plan,
    argv: plan.argv,
    rawCommand: plan.commandText,
    cwd: plan.cwd ?? params.request.workdir,
    agentId: plan.agentId ?? params.request.agentId,
    sessionKey: plan.sessionKey ?? params.request.sessionKey,
  };
}

export async function analyzeNodeApprovalRequirement(params: {
  request: ExecuteNodeHostCommandParams;
  target: NodeExecutionTarget;
  prepared: PreparedNodeRun;
  hostSecurity: ExecSecurity;
  hostAsk: ExecAsk;
}): Promise<NodeApprovalAnalysis> {
  const baseAllowlistEval = evaluateShellAllowlist({
    command: params.request.command,
    allowlist: [],
    safeBins: new Set(),
    cwd: params.request.workdir,
    env: params.request.env,
    platform: params.target.platform,
    trustedSafeBinDirs: params.request.trustedSafeBinDirs,
  });
  let analysisOk = baseAllowlistEval.analysisOk;
  let allowlistSatisfied = false;
  let durableApprovalSatisfied = false;
  const inlineEvalHit =
    params.request.strictInlineEval === true
      ? detectPolicyInlineEval(baseAllowlistEval.segments)
      : null;
  if (inlineEvalHit) {
    params.request.warnings.push(
      `Warning: strict inline-eval mode requires explicit approval for ${describeInterpreterInlineEval(
        inlineEvalHit,
      )}.`,
    );
  }
  if ((params.hostAsk === "always" || params.hostSecurity === "allowlist") && analysisOk) {
    try {
      const approvalsSnapshot = await callGatewayTool<{ file: string }>(
        "exec.approvals.node.get",
        { timeoutMs: 10_000 },
        { nodeId: params.target.nodeId },
      );
      const approvalsFile =
        approvalsSnapshot && typeof approvalsSnapshot === "object"
          ? approvalsSnapshot.file
          : undefined;
      if (approvalsFile && typeof approvalsFile === "object") {
        const resolved = resolveExecApprovalsFromFile({
          file: approvalsFile as ExecApprovalsFile,
          agentId: params.request.agentId,
          overrides: { security: "full" },
        });
        // Allowlist-only precheck; safe bins are node-local and may diverge.
        const allowlistEval = evaluateShellAllowlist({
          command: params.request.command,
          allowlist: resolved.allowlist,
          safeBins: new Set(),
          cwd: params.request.workdir,
          env: params.request.env,
          platform: params.target.platform,
          trustedSafeBinDirs: params.request.trustedSafeBinDirs,
        });
        durableApprovalSatisfied = hasDurableExecApproval({
          analysisOk: allowlistEval.analysisOk,
          segmentAllowlistEntries: allowlistEval.segmentAllowlistEntries,
          allowlist: resolved.allowlist,
          commandText: params.prepared.rawCommand,
        });
        allowlistSatisfied = allowlistEval.allowlistSatisfied;
        analysisOk = allowlistEval.analysisOk;
      }
    } catch {
      // Fall back to requiring approval if node approvals cannot be fetched.
    }
  }
  return {
    analysisOk,
    allowlistSatisfied,
    durableApprovalSatisfied,
    inlineEvalHit,
  };
}
