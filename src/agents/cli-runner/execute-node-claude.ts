import crypto from "node:crypto";
import type { invokeNodeClaudeCliRun } from "../../gateway/node-agent-cli-runtime.js";
import { createAbortError } from "../../infra/abort-signal.js";
import type { ExecAsk, ExecSecurity, SystemRunApprovalPlan } from "../../infra/exec-approvals.js";
import type { RunExit } from "../../process/supervisor/types.js";
import type {
  registerExecApprovalRequestForHostOrThrow,
  resolveRegisteredExecApprovalDecision,
} from "../bash-tools.exec-approval-request.js";
import type { PreparedCliRunContext } from "./types.js";

const NODE_CLI_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const NODE_CLI_MAX_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

type NodeClaudePlacement = { nodeId: string; cwd?: string };

export function resolveNodeClaudePlacement(
  context: PreparedCliRunContext,
): NodeClaudePlacement | null {
  const entry = context.params.sessionEntry;
  const nodeId = entry?.execNode?.trim();
  // For claude-cli, the session placement tuple owns both agent turns and
  // their exec tools so the CLI, auth, transcript, and commands stay together.
  if (context.backendResolved.id !== "claude-cli" || entry?.execHost !== "node") {
    return null;
  }
  if (!nodeId) {
    throw new Error("node-placed Claude CLI session is missing execNode");
  }
  return { nodeId, ...(entry.execCwd?.trim() ? { cwd: entry.execCwd.trim() } : {}) };
}

const NODE_CLI_OMIT_BARE_ARGS = new Set(["--strict-mcp-config"]);
const NODE_CLI_OMIT_VALUE_ARGS = new Set([
  "--permission-mode",
  "--plugin-dir",
  "--plugin-dir-no-mcp",
]);
// --tools and --disallowedTools stay: they carry the gateway's native tool
// policy onto the node. --allowedTools is stripped because Claude treats it as
// auto-approval, which must never cross the node's own approval boundary.
const NODE_CLI_OMIT_VARIADIC_ARGS = new Set(["--mcp-config", "--allowedTools", "--allowed-tools"]);

/** Remove Gateway-local file, plugin, MCP, and allow-list arguments. */
export function stripGatewayLocalClaudeArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const equalsIndex = arg.indexOf("=");
    const name = equalsIndex > 0 ? arg.slice(0, equalsIndex) : arg;
    if (NODE_CLI_OMIT_BARE_ARGS.has(name)) {
      continue;
    }
    if (NODE_CLI_OMIT_VALUE_ARGS.has(name)) {
      if (equalsIndex < 0) {
        index += 1;
      }
      continue;
    }
    if (NODE_CLI_OMIT_VARIADIC_ARGS.has(name)) {
      if (equalsIndex < 0) {
        while (typeof args[index + 1] === "string" && !args[index + 1]?.startsWith("-")) {
          index += 1;
        }
      }
      continue;
    }
    result.push(arg);
  }
  return result;
}

function parseNodeClaudeResultPayload(result: { payload?: unknown; payloadJSON?: string | null }): {
  exitCode: number;
  stderrTail: string;
  truncated: boolean;
  timeoutKind?: "hard" | "idle";
} {
  const value = result.payloadJSON ? (JSON.parse(result.payloadJSON) as unknown) : result.payload;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("paired node returned an invalid Claude CLI result");
  }
  const record = value as Record<string, unknown>;
  if (
    !Number.isInteger(record.exitCode) ||
    typeof record.stderrTail !== "string" ||
    typeof record.truncated !== "boolean" ||
    (record.timeoutKind !== undefined &&
      record.timeoutKind !== "hard" &&
      record.timeoutKind !== "idle")
  ) {
    throw new Error("paired node returned an invalid Claude CLI result");
  }
  return {
    exitCode: record.exitCode as number,
    stderrTail: record.stderrTail,
    truncated: record.truncated,
    ...(record.timeoutKind ? { timeoutKind: record.timeoutKind as "hard" | "idle" } : {}),
  };
}

type NodeClaudeApprovalRequired = {
  systemRunPlan: SystemRunApprovalPlan;
  security: ExecSecurity;
  ask: ExecAsk;
};

function parseNodeClaudeApprovalRequired(result: {
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string | null;
}): NodeClaudeApprovalRequired | null {
  if (!result.ok) {
    return null;
  }
  const value = result.payloadJSON ? (JSON.parse(result.payloadJSON) as unknown) : result.payload;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.approvalRequired !== true ||
    !record.systemRunPlan ||
    typeof record.systemRunPlan !== "object" ||
    Array.isArray(record.systemRunPlan) ||
    (record.security !== "deny" && record.security !== "allowlist" && record.security !== "full") ||
    (record.ask !== "off" && record.ask !== "on-miss" && record.ask !== "always")
  ) {
    return null;
  }
  return {
    systemRunPlan: record.systemRunPlan as SystemRunApprovalPlan,
    security: record.security,
    ask: record.ask,
  };
}

export function createCliAbortError(): Error {
  return createAbortError("CLI run aborted");
}

async function waitForNodeOperation<T>(params: {
  operation: Promise<T>;
  signal?: AbortSignal;
}): Promise<T> {
  if (!params.signal) {
    return await params.operation;
  }
  if (params.signal.aborted) {
    throw createCliAbortError();
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createCliAbortError());
    params.signal?.addEventListener("abort", onAbort, { once: true });
    void params.operation.then(resolve, reject).finally(() => {
      params.signal?.removeEventListener("abort", onAbort);
    });
  });
}

type ExecuteNodeClaudeRunDeps = {
  invokeNodeClaudeCliRun: typeof invokeNodeClaudeCliRun;
  registerExecApprovalRequestForHostOrThrow: typeof registerExecApprovalRequestForHostOrThrow;
  resolveRegisteredExecApprovalDecision: typeof resolveRegisteredExecApprovalDecision;
};

export async function executeNodeClaudeRun(params: {
  context: PreparedCliRunContext;
  nodePlacement: NodeClaudePlacement;
  executionArgs: string[];
  stdinPayload: string;
  nodeSystemPrompt?: string;
  noOutputTimeoutMs: number;
  consumeStdout: (chunk: string) => void;
  consumeStderr: (chunk: string) => void;
  deps: ExecuteNodeClaudeRunDeps;
}): Promise<{
  result: RunExit;
  nodeRunAbortSignal: AbortSignal;
  nodeRunTruncated: boolean;
}> {
  const contextParams = params.context.params;
  const startedAt = Date.now();
  const hardTimeoutMs = Math.min(contextParams.timeoutMs, NODE_CLI_MAX_TIMEOUT_MS);
  const hardDeadlineAt = startedAt + hardTimeoutMs;
  const nodeAbortController = new AbortController();
  const nodeRunAbortSignal = nodeAbortController.signal;
  let hardDeadlineReached = false;
  const hardDeadlineTimer = setTimeout(() => {
    hardDeadlineReached = true;
    nodeAbortController.abort();
  }, hardTimeoutMs);
  const abortNodeRun = () => nodeAbortController.abort();
  contextParams.abortSignal?.addEventListener("abort", abortNodeRun, { once: true });
  if (contextParams.abortSignal?.aborted) {
    abortNodeRun();
  }
  let replyBackendCompleted = false;
  const replyBackendHandle = contextParams.replyOperation
    ? {
        kind: "cli" as const,
        cancel: abortNodeRun,
        isStreaming: () => !replyBackendCompleted,
      }
    : undefined;
  if (replyBackendHandle) {
    contextParams.replyOperation?.attachBackend(replyBackendHandle);
  }
  let nodeResult: Awaited<ReturnType<typeof invokeNodeClaudeCliRun>>;
  try {
    const invokeNode = async (approval?: {
      decision: "allow-once" | "allow-always";
      plan: SystemRunApprovalPlan;
    }) => {
      const remainingTimeoutMs = hardDeadlineAt - Date.now();
      if (remainingTimeoutMs <= 0) {
        hardDeadlineReached = true;
        nodeAbortController.abort();
        return {
          ok: false,
          error: {
            code: "TIMEOUT",
            message: "paired-node Claude CLI invocation exceeded its hard timeout",
          },
        };
      }
      return await params.deps.invokeNodeClaudeCliRun({
        nodeId: params.nodePlacement.nodeId,
        argv: params.executionArgs,
        stdin: params.stdinPayload,
        ...(params.nodePlacement.cwd ? { cwd: params.nodePlacement.cwd } : {}),
        ...(params.nodeSystemPrompt !== undefined ? { systemPrompt: params.nodeSystemPrompt } : {}),
        ...(contextParams.agentId ? { agentId: contextParams.agentId } : {}),
        ...(contextParams.sessionKey ? { sessionKey: contextParams.sessionKey } : {}),
        ...(approval
          ? {
              approvalDecision: approval.decision,
              systemRunPlan: approval.plan,
            }
          : {}),
        timeoutMs: remainingTimeoutMs,
        idleTimeoutMs: Math.max(
          1_000,
          Math.min(params.noOutputTimeoutMs, NODE_CLI_MAX_IDLE_TIMEOUT_MS),
        ),
        onProgress: params.consumeStdout,
        signal: nodeAbortController.signal,
      });
    };
    nodeResult = await invokeNode();
    const approval = parseNodeClaudeApprovalRequired(nodeResult);
    if (approval) {
      const approvalId = crypto.randomUUID();
      const registration = await waitForNodeOperation({
        operation: params.deps.registerExecApprovalRequestForHostOrThrow({
          approvalId,
          command: approval.systemRunPlan.commandText,
          commandArgv: approval.systemRunPlan.argv,
          systemRunPlan: approval.systemRunPlan,
          workdir: approval.systemRunPlan.cwd ?? undefined,
          host: "node",
          nodeId: params.nodePlacement.nodeId,
          security: approval.security,
          ask: approval.ask,
          unavailableDecisions: ["allow-always"],
          agentId: contextParams.agentId,
          sessionKey: contextParams.sessionKey,
          ...(contextParams.approvalReviewerDeviceId
            ? { approvalReviewerDeviceIds: [contextParams.approvalReviewerDeviceId] }
            : {}),
        }),
        signal: nodeAbortController.signal,
      });
      const decision = await waitForNodeOperation({
        operation: params.deps.resolveRegisteredExecApprovalDecision({
          approvalId: registration.id,
          preResolvedDecision: registration.finalDecision,
        }),
        signal: nodeAbortController.signal,
      });
      if (decision === "allow-once" || decision === "allow-always") {
        nodeResult = await invokeNode({ decision, plan: approval.systemRunPlan });
      } else {
        nodeResult = {
          ok: false,
          error: {
            code: "PERMISSION_DENIED",
            message: "paired-node Claude CLI agent run was not approved",
          },
        };
      }
    }
  } catch (error) {
    if (!hardDeadlineReached) {
      throw error;
    }
    nodeResult = {
      ok: false,
      error: {
        code: "TIMEOUT",
        message: "paired-node Claude CLI invocation exceeded its hard timeout",
      },
    };
  } finally {
    clearTimeout(hardDeadlineTimer);
    replyBackendCompleted = true;
    if (replyBackendHandle) {
      contextParams.replyOperation?.detachBackend(replyBackendHandle);
    }
    contextParams.abortSignal?.removeEventListener("abort", abortNodeRun);
  }
  if (hardDeadlineReached) {
    nodeResult = {
      ok: false,
      error: {
        code: "TIMEOUT",
        message: "paired-node Claude CLI invocation exceeded its hard timeout",
      },
    };
  }
  if (!nodeResult.ok) {
    const code = nodeResult.error?.code;
    const timedOut = code === "TIMEOUT" || code === "IDLE_TIMEOUT";
    const result: RunExit = {
      reason:
        code === "IDLE_TIMEOUT"
          ? "no-output-timeout"
          : code === "TIMEOUT"
            ? "overall-timeout"
            : code === "ABORTED"
              ? "manual-cancel"
              : "exit",
      exitCode: timedOut || code === "ABORTED" ? null : 1,
      exitSignal: null,
      durationMs: Date.now() - startedAt,
      stdout: "",
      stderr: nodeResult.error?.message ?? "paired-node Claude CLI invocation failed",
      timedOut,
      noOutputTimedOut: code === "IDLE_TIMEOUT",
    };
    params.consumeStderr(result.stderr);
    return { result, nodeRunAbortSignal, nodeRunTruncated: false };
  }
  const payload = parseNodeClaudeResultPayload(nodeResult);
  if (payload.stderrTail) {
    params.consumeStderr(payload.stderrTail);
  }
  const result: RunExit = {
    reason:
      payload.timeoutKind === "idle"
        ? "no-output-timeout"
        : payload.timeoutKind === "hard"
          ? "overall-timeout"
          : "exit",
    exitCode: payload.timeoutKind ? null : payload.exitCode,
    exitSignal: null,
    durationMs: Date.now() - startedAt,
    stdout: "",
    stderr: payload.stderrTail,
    timedOut: payload.timeoutKind !== undefined,
    noOutputTimedOut: payload.timeoutKind === "idle",
  };
  return { result, nodeRunAbortSignal, nodeRunTruncated: payload.truncated };
}
