import { Type } from "typebox";
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
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { isTerminalTaskStatus } from "../../tasks/task-executor-policy.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readPositiveIntegerParam,
  readToolStringParam,
  ToolInputError,
} from "./common.js";
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
>;

type TerminalToolOptions = {
  agentId?: string;
  agentSessionKey?: string;
  runId?: string;
  lookupTaskByRunIdForChildSession?: (
    runId: string,
    childSessionKey: string,
  ) => Promise<Pick<TaskRecord, "taskId" | "status" | "childSessionKey"> | undefined>;
  getGatewayContext?: () => TerminalToolGatewayContext | undefined;
};

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
      "Own terminal on gateway host. open/read/input/resize/close/list. Operator can attach in web UI and type too. read = buffer snapshot.",
    parameters: TerminalToolSchema,
    outputSchema: TerminalToolOutputSchema,
    execute: async (_toolCallId, rawArgs, signal) => {
      const params = rawArgs as Record<string, unknown>;
      const action = readToolStringParam(params, "action", { required: true });
      const agentSessionKey = opts.agentSessionKey?.trim();
      if (!agentSessionKey) {
        throw new ToolInputError("agent session required");
      }
      const agentId = opts.agentId?.trim() || resolveAgentIdFromSessionKey(agentSessionKey);
      const context = getContext();
      const manager = context?.terminalSessions;
      if (!context || !manager) {
        throw new ToolInputError("terminal unavailable");
      }

      if (action === "list") {
        return jsonResult({ sessions: manager.listAgent(agentSessionKey, agentId) });
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
        const runId = opts.runId?.trim();
        const taskLookupId = runId ? (getAgentRunTaskRunId(runId) ?? runId) : undefined;
        const task = taskLookupId ? await findOwnerTask(taskLookupId, agentSessionKey) : undefined;
        if (task && isTerminalTaskStatus(task.status)) {
          throw new ToolInputError("terminal task already ended");
        }
        const taskId = task?.taskId;
        const owner = {
          kind: "agent",
          agentSessionKey,
          agentId,
          ...(taskId ? { taskId } : {}),
        } as const;
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
              owner,
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
                  manager.closeAgent(agentSessionKey, lateOutcome.sessionId, agentId);
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
          const commandOutcome = manager.writeAgent(
            agentSessionKey,
            outcome.sessionId,
            `${command}\r`,
            agentId,
          );
          if (!commandOutcome.ok) {
            manager.closeAgent(agentSessionKey, outcome.sessionId, agentId);
            terminalActionResult("initial command", commandOutcome);
          }
        }
        return jsonResult(outcome);
      }

      const sessionId = requireSessionId(params);
      if (action === "read") {
        const raw = manager.snapshotAgent(agentSessionKey, sessionId, agentId);
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
        return terminalActionResult(
          "input",
          manager.writeAgent(agentSessionKey, sessionId, data, agentId),
        );
      }
      if (action === "resize") {
        return terminalActionResult(
          "resize",
          manager.resizeAgent(
            agentSessionKey,
            sessionId,
            readDimension(params, "cols"),
            readDimension(params, "rows"),
            agentId,
          ),
        );
      }
      if (action === "close") {
        return terminalActionResult(
          "close",
          manager.closeAgent(agentSessionKey, sessionId, agentId),
        );
      }
      throw new ToolInputError(`Unknown action: ${action}`);
    },
  };
}
