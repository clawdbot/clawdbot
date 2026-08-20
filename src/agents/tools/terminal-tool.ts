import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { renderTerminalBufferText } from "../../gateway/terminal/buffer-text.js";
import { buildTerminalEnv, resolveTerminalSpawnPlan } from "../../gateway/terminal/launch.js";
import {
  createTerminalOpenDeadline,
  TerminalOpenDeadlineError,
  waitForTerminalOpenDeadline,
} from "../../gateway/terminal/open-deadline.js";
import type { TerminalAgentActionOutcome } from "../../gateway/terminal/session-manager.types.js";
import { getAgentRunTaskRunId } from "../../infra/agent-run-registry.js";
import {
  DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  loadExecApprovals,
  type ExecApprovalsFile,
  type ExecAsk,
  type ExecMode,
  type ExecSecurity,
} from "../../infra/exec-approvals.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { isTerminalTaskStatus } from "../../tasks/task-executor-policy.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { resolveExecDefaults, type ExecPolicyOverrides } from "../exec-defaults.js";
import type { PreparedSessionPermissionPolicy } from "../tool-fs-policy.types.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readPositiveIntegerParam,
  readToolStringParam,
  ToolInputError,
} from "./common.js";
import { callGatewayTool } from "./gateway.js";
import { getInProcessGatewayToolContext } from "./in-process-gateway.js";

const ACTIONS = ["open", "read", "input", "resize", "close", "list"] as const;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const MAX_DIMENSION = 2000;

const TerminalToolSchema = Type.Object(
  {
    action: Type.String({ enum: [...ACTIONS], description: "Action" }),
    sessionId: Type.Optional(Type.String({ description: "Own terminal session" })),
    command: Type.Optional(Type.String({ description: "Initial shell command" })),
    cwd: Type.Optional(Type.String({ description: "Start directory" })),
    data: Type.Optional(Type.String({ description: "Raw terminal input" })),
    cols: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DIMENSION })),
    rows: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DIMENSION })),
  },
  { additionalProperties: false },
);

const TerminalListSessionSchema = Type.Object(
  {
    sessionId: Type.String(),
    agentId: Type.String(),
    shell: Type.String(),
    cwd: Type.String(),
    attached: Type.Boolean(),
    owner: Type.String({ pattern: "^agent:.+" }),
    createdAtMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const TerminalToolOutputSchema = Type.Union([
  Type.Object({ sessions: Type.Array(TerminalListSessionSchema) }, { additionalProperties: false }),
  Type.Object(
    {
      ok: Type.Literal(true),
      sessionId: Type.String(),
      agentId: Type.String(),
      cwd: Type.String(),
      shell: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object({ sessionId: Type.String(), text: Type.String() }, { additionalProperties: false }),
  Type.Object({ ok: Type.Literal(true) }, { additionalProperties: false }),
]);

const TERMINAL_RECOVERY_GUIDANCE =
  "Use action=list to find an owned terminal or action=open to acquire one.";
const TERMINAL_UNAVAILABLE_MESSAGE = `Terminal session unavailable. ${TERMINAL_RECOVERY_GUIDANCE}`;

function terminalActionResult(
  action: "initial command" | "input" | "resize" | "close",
  outcome: TerminalAgentActionOutcome,
): ReturnType<typeof jsonResult> {
  if (!outcome.ok) {
    throw new ToolInputError(
      outcome.code === "session_unavailable"
        ? TERMINAL_UNAVAILABLE_MESSAGE
        : `Terminal ${action} failed. ${TERMINAL_RECOVERY_GUIDANCE}`,
    );
  }
  return jsonResult({ ok: true });
}

type TerminalToolGatewayContext = Pick<
  GatewayRequestContext,
  "isTerminalEnabled" | "resolveTerminalLaunchPolicy" | "terminalSessions"
> & { getRuntimeConfig?: () => OpenClawConfig };

type TerminalToolOptions = {
  agentId?: string;
  agentSessionKey?: string;
  sessionId?: string;
  runId?: string;
  /** Runtime config used to resolve the effective exec policy for this agent. */
  cfg?: OpenClawConfig;
  /** Preloaded host exec approvals; defaults to the local approvals file. */
  execApprovals?: ExecApprovalsFile;
  /** Resolves the effective exec policy that gates agent terminal opens. */
  resolveExecPolicy?: TerminalExecPolicyResolver;
  /** Requests one exec approval for an interactive terminal session. */
  requestTerminalApproval?: TerminalApprovalRequester;
  /** Deny approval-requiring terminal opens without creating approval events. */
  nonInteractiveApproval?: boolean;
  /**
   * Prepared session permission policy. When set, the terminal inherits the
   * same hard short-circuit the exec tool enforces (read-only → deny,
   * guarded → ask), so a restricted session cannot open a host PTY even when
   * the global exec policy is permissive.
   */
  sessionPermissionPolicy?: PreparedSessionPermissionPolicy;
  /**
   * Per-run exec policy overrides (security/ask/host) the exec tool already
   * applies. Forwarded to resolveExecDefaults so a run-level deny/ask override
   * is honored by terminal opens, not just by the exec tool.
   */
  execOverrides?: ExecPolicyOverrides;
  lookupTaskByRunIdForChildSession?: (
    runId: string,
    childSessionKey: string,
  ) => Promise<Pick<TaskRecord, "taskId" | "status" | "childSessionKey"> | undefined>;
  getGatewayContext?: () => TerminalToolGatewayContext | undefined;
};

/** Effective exec policy surface consulted before opening an agent terminal. */
type TerminalExecPolicy = {
  mode: ExecMode;
  security: ExecSecurity;
  ask: ExecAsk;
};

type TerminalExecPolicyResolver = (params: {
  cfg?: OpenClawConfig;
  execApprovals?: ExecApprovalsFile;
  agentId: string;
  sessionKey: string;
  sessionPermissionPolicy?: PreparedSessionPermissionPolicy;
  execOverrides?: ExecPolicyOverrides;
}) => TerminalExecPolicy;

type TerminalApprovalRequester = (params: {
  agentId: string;
  agentSessionKey: string;
  runId?: string;
  toolCallId?: string;
  shell: string;
  args: string[];
  cwd: string;
  initialCommand?: string;
  security: ExecSecurity;
  ask: ExecAsk;
}) => Promise<boolean>;

const DEFAULT_TERMINAL_APPROVAL_TIMEOUT_MS = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
const DEFAULT_TERMINAL_APPROVAL_REQUEST_TIMEOUT_MS = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS + 10_000;

/** Resolves the same effective exec policy the exec tool enforces. */
function resolveTerminalExecPolicyDefault(
  params: Parameters<TerminalExecPolicyResolver>[0],
): TerminalExecPolicy {
  const defaults = resolveExecDefaults({
    cfg: params.cfg,
    execApprovals: params.execApprovals ?? loadExecApprovals(),
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    // Carry the prepared session permission through so the terminal inherits
    // the same hard short-circuit (read-only → deny, guarded → ask) the exec
    // tool applies. Without this, a restricted session can still open a host
    // PTY when the global exec policy is permissive.
    ...(params.sessionPermissionPolicy
      ? { sessionEntry: { permissionMode: params.sessionPermissionPolicy.mode } }
      : {}),
    // Carry per-run exec overrides (security/ask/host) the exec tool already
    // applies, so a run-level deny/ask override is honored by terminal opens.
    ...(params.execOverrides ? { execOverrides: params.execOverrides } : {}),
  });
  return { mode: defaults.mode, security: defaults.security, ask: defaults.ask };
}

/**
 * Requests one bounded "allow-once" exec approval for an interactive terminal
 * session. The approval gates only the PTY open; the running session remains
 * visible to the operator in the web UI and is closed with its owning task.
 */
async function requestTerminalApprovalDefault(
  params: Parameters<TerminalApprovalRequester>[0],
): Promise<boolean> {
  const shellPreview = [params.shell, ...params.args].filter(Boolean).join(" ") || "default shell";
  const commandText = params.initialCommand?.trim()
    ? `terminal: ${params.initialCommand}`
    : `terminal: open interactive shell (${shellPreview}, cwd: ${params.cwd})`;
  const registration = await callGatewayTool<{ id?: string | null }>(
    "exec.approval.request",
    { timeoutMs: DEFAULT_TERMINAL_APPROVAL_REQUEST_TIMEOUT_MS },
    {
      command: commandText,
      commandArgv: [params.shell, ...params.args],
      host: "gateway",
      cwd: params.cwd,
      security: params.security,
      ask: params.ask,
      // An interactive shell cannot inherit an indefinite "allow-always" grant.
      unavailableDecisions: ["allow-always"],
      agentId: params.agentId,
      sessionKey: params.agentSessionKey,
      runId: params.runId ?? null,
      toolCallId: params.toolCallId ?? null,
      timeoutMs: DEFAULT_TERMINAL_APPROVAL_TIMEOUT_MS,
      twoPhase: true,
    },
    { expectFinal: false },
  );
  const approvalId = typeof registration?.id === "string" ? registration.id : null;
  if (!approvalId) {
    return false;
  }
  const decision = await callGatewayTool<{ decision?: string | null }>(
    "exec.approval.waitDecision",
    { timeoutMs: DEFAULT_TERMINAL_APPROVAL_REQUEST_TIMEOUT_MS },
    { id: approvalId },
  );
  return decision?.decision === "allow-once";
}

async function lookupTaskByRunIdForChildSession(
  runId: string,
  childSessionKey: string,
): Promise<Pick<TaskRecord, "taskId" | "status" | "childSessionKey"> | undefined> {
  const { findTaskByRunIdForChildSessionForStatus } =
    await import("../../tasks/task-status-access.js");
  return findTaskByRunIdForChildSessionForStatus(runId, childSessionKey);
}

function readDimension(
  params: Record<string, unknown>,
  key: "cols" | "rows",
  fallback?: number,
): number {
  const value = readPositiveIntegerParam(params, key, {
    max: MAX_DIMENSION,
    message: `${key} must be an integer from 1 to ${MAX_DIMENSION}`,
  });
  if (value !== undefined) {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new ToolInputError(`${key} required`);
}

function readOptionalStringParam(
  params: Record<string, unknown>,
  key: "command" | "cwd",
  options: { trim?: boolean } = {},
): string | undefined {
  if (params[key] === undefined) {
    return undefined;
  }
  if (typeof params[key] !== "string") {
    throw new ToolInputError(`${key} must be string`);
  }
  return readToolStringParam(params, key, options);
}

function requireSessionId(params: Record<string, unknown>): string {
  return readToolStringParam(params, "sessionId", { required: true });
}

function launchBlockMessage(
  block: Extract<
    ReturnType<GatewayRequestContext["resolveTerminalLaunchPolicy"]>,
    { ok: false }
  >["block"],
): string {
  if (block.kind === "disabled") {
    return "terminal disabled";
  }
  if (block.kind === "unknown-agent") {
    return `unknown agent: ${block.agentId}`;
  }
  if (block.kind === "owner-required") {
    return block.message;
  }
  return `terminal unavailable: agent sandboxed (${block.mode})`;
}

export function createTerminalTool(opts: TerminalToolOptions = {}): AnyAgentTool {
  const getContext = opts.getGatewayContext ?? getInProcessGatewayToolContext;
  const findOwnerTask = opts.lookupTaskByRunIdForChildSession ?? lookupTaskByRunIdForChildSession;
  return {
    label: "Terminal",
    name: "terminal",
    description:
      "Shared session terminal on gateway host. open/read/input/resize/close/list. Terminals opened from this chat's Control UI panel are shared with the agent; read = buffer snapshot.",
    parameters: TerminalToolSchema,
    outputSchema: TerminalToolOutputSchema,
    execute: async (_toolCallId, rawArgs, signal) => {
      const params = rawArgs as Record<string, unknown>;
      const action = readToolStringParam(params, "action", { required: true });
      const agentSessionKey = opts.agentSessionKey?.trim();
      if (!agentSessionKey) {
        throw new ToolInputError("agent session required");
      }
      const agentSessionId = opts.sessionId?.trim();
      if (!agentSessionId) {
        throw new ToolInputError("agent session id required");
      }
      const agentId = opts.agentId?.trim() || resolveAgentIdFromSessionKey(agentSessionKey);
      const owner = { kind: "agent", agentSessionKey, agentSessionId, agentId } as const;
      const context = getContext();
      const manager = context?.terminalSessions;
      if (!context || !manager) {
        throw new ToolInputError("terminal unavailable");
      }

      if (action === "list") {
        return jsonResult({ sessions: manager.listAgent(owner) });
      }

      if (action === "open") {
        const command = readOptionalStringParam(params, "command", { trim: false });
        const cwd = readOptionalStringParam(params, "cwd");
        const cols = readDimension(params, "cols", DEFAULT_COLS);
        const rows = readDimension(params, "rows", DEFAULT_ROWS);
        if (!context.isTerminalEnabled()) {
          throw new ToolInputError("terminal disabled");
        }
        const launch = context.resolveTerminalLaunchPolicy(agentId);
        if (!launch.ok) {
          throw new ToolInputError(launchBlockMessage(launch.block));
        }
        const spawnPlan = resolveTerminalSpawnPlan({
          ...launch.plan,
          ...(cwd ? { cwdOverride: cwd } : {}),
        });
        const execPolicy = (opts.resolveExecPolicy ?? resolveTerminalExecPolicyDefault)({
          cfg: opts.cfg ?? context?.getRuntimeConfig?.(),
          execApprovals: opts.execApprovals,
          agentId,
          sessionKey: agentSessionKey,
          sessionPermissionPolicy: opts.sessionPermissionPolicy,
          execOverrides: opts.execOverrides,
        });
        if (execPolicy.mode === "deny" || execPolicy.security === "deny") {
          throw new ToolInputError(
            "terminal unavailable: exec policy denies host command execution",
          );
        }
        if (execPolicy.security === "allowlist" && execPolicy.ask === "off") {
          throw new ToolInputError(
            "terminal unavailable: exec policy is allowlist-only; an interactive shell cannot be allowlisted",
          );
        }
        if (execPolicy.ask !== "off") {
          if (opts.nonInteractiveApproval) {
            throw new ToolInputError(
              "terminal open denied: exec approval is required but the non-interactive approval policy denies it",
            );
          }
          const approved = await (opts.requestTerminalApproval ?? requestTerminalApprovalDefault)({
            agentId,
            agentSessionKey,
            runId: opts.runId,
            toolCallId: _toolCallId,
            shell: spawnPlan.shell,
            args: spawnPlan.args,
            cwd: spawnPlan.cwd,
            initialCommand: command,
            security: execPolicy.security,
            ask: execPolicy.ask,
          });
          if (!approved) {
            throw new ToolInputError("terminal open denied: exec approval not granted");
          }
        }
        // Revalidate run authority after the awaited approval. The
        // host-capability wrapper asserts authority at execute entry/exit,
        // but an interactive approval await can straddle run closure or
        // rotation — recheck the canonical run abort signal (the same source
        // assertActive's capabilityAbortController feeds) so a stale run
        // fails closed before any gateway-host PTY is spawned.
        if (signal?.aborted) {
          throw new ToolInputError("terminal open denied: requesting run is no longer active");
        }
        const runId = opts.runId?.trim();
        const taskLookupId = runId ? (getAgentRunTaskRunId(runId) ?? runId) : undefined;
        const task = taskLookupId ? await findOwnerTask(taskLookupId, agentSessionKey) : undefined;
        if (task && isTerminalTaskStatus(task.status)) {
          throw new ToolInputError("terminal task already ended");
        }
        const taskId = task?.taskId;
        const terminalOwner = { ...owner, ...(taskId ? { taskId } : {}) };
        const deadline = createTerminalOpenDeadline();
        const cancelOpen = () => {
          if (!deadline.controller.signal.aborted) {
            deadline.controller.abort(signal?.reason ?? new Error("terminal open cancelled"));
          }
        };
        if (signal?.aborted) {
          cancelOpen();
        } else {
          signal?.addEventListener("abort", cancelOpen, { once: true });
        }
        let openingTerminal: ReturnType<typeof manager.open> | undefined;
        let outcome: Awaited<ReturnType<typeof manager.open>>;
        try {
          outcome = await waitForTerminalOpenDeadline(() => {
            openingTerminal = manager.open({
              owner: terminalOwner,
              agentId: spawnPlan.agentId,
              cwd: spawnPlan.cwd,
              shell: spawnPlan.shell,
              args: spawnPlan.args,
              cols,
              rows,
              env: buildTerminalEnv(process.env),
              signal: deadline.controller.signal,
            });
            return openingTerminal;
          }, deadline);
        } catch (error) {
          if (openingTerminal) {
            void openingTerminal.then(
              (lateOutcome) => {
                if (lateOutcome.ok) {
                  manager.closeAgent(owner, lateOutcome.sessionId);
                }
              },
              () => undefined,
            );
          }
          if (error instanceof TerminalOpenDeadlineError) {
            throw new ToolInputError(error.message);
          }
          throw error;
        } finally {
          signal?.removeEventListener("abort", cancelOpen);
        }
        if (!outcome.ok) {
          throw new ToolInputError(outcome.message);
        }
        if (command !== undefined) {
          const commandOutcome = manager.writeAgent(owner, outcome.sessionId, `${command}\r`);
          if (!commandOutcome.ok) {
            manager.closeAgent(owner, outcome.sessionId);
            terminalActionResult("initial command", commandOutcome);
          }
        }
        return jsonResult(outcome);
      }

      const sessionId = requireSessionId(params);
      if (action === "read") {
        const raw = manager.snapshotAgent(owner, sessionId);
        if (raw === undefined) {
          throw new ToolInputError(TERMINAL_UNAVAILABLE_MESSAGE);
        }
        return jsonResult({ sessionId, text: renderTerminalBufferText(raw) });
      }
      if (action === "input") {
        const data = readToolStringParam(params, "data", {
          required: true,
          trim: false,
          allowEmpty: true,
        });
        return terminalActionResult("input", manager.writeAgent(owner, sessionId, data));
      }
      if (action === "resize") {
        return terminalActionResult(
          "resize",
          manager.resizeAgent(
            owner,
            sessionId,
            readDimension(params, "cols"),
            readDimension(params, "rows"),
          ),
        );
      }
      if (action === "close") {
        return terminalActionResult("close", manager.closeAgent(owner, sessionId));
      }
      throw new ToolInputError(`Unknown action: ${action}`);
    },
  };
}
