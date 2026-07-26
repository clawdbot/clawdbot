import { Type } from "typebox";
import type { UiCommandParams } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { renderTerminalBufferText } from "../../gateway/terminal/buffer-text.js";
import { buildTerminalEnv, resolveTerminalSpawnPlan } from "../../gateway/terminal/launch.js";
import {
  createTerminalOpenDeadline,
  TerminalOpenDeadlineError,
  waitForTerminalOpenDeadline,
} from "../../gateway/terminal/open-deadline.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readPositiveIntegerParam, readStringParam, ToolInputError } from "./common.js";
import {
  callInProcessGatewayTool,
  getInProcessGatewayToolContext,
  type InProcessGatewayCaller,
} from "./in-process-gateway.js";

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
    show: Type.Optional(Type.Boolean({ description: "Show in web UI. Default: true" })),
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
  Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
]);

type TerminalToolGatewayContext = Pick<
  GatewayRequestContext,
  "isTerminalEnabled" | "resolveTerminalLaunchPolicy" | "terminalSessions"
>;

type TerminalToolOptions = {
  agentId?: string;
  agentSessionKey?: string;
  callGateway?: InProcessGatewayCaller;
  getGatewayContext?: () => TerminalToolGatewayContext | undefined;
};

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

function readShow(params: Record<string, unknown>): boolean {
  const value = params.show;
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    throw new ToolInputError("show must be boolean");
  }
  return value;
}

function readOptionalString(
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
  return readStringParam(params, key, options);
}

function requireSessionId(params: Record<string, unknown>): string {
  return readStringParam(params, "sessionId", { required: true });
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
  return `terminal unavailable: agent sandboxed (${block.mode})`;
}

export function createTerminalTool(opts: TerminalToolOptions = {}): AnyAgentTool {
  const gatewayCall = opts.callGateway ?? callInProcessGatewayTool;
  const getContext = opts.getGatewayContext ?? getInProcessGatewayToolContext;
  return {
    label: "Terminal",
    name: "terminal",
    description:
      "Own terminal on gateway host. open/read/input/close. User sees it in web UI, can type too. read = buffer snapshot.",
    parameters: TerminalToolSchema,
    outputSchema: TerminalToolOutputSchema,
    execute: async (_toolCallId, rawArgs, signal) => {
      const params = rawArgs as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const agentSessionKey = opts.agentSessionKey?.trim();
      if (!agentSessionKey) {
        throw new ToolInputError("agent session required");
      }
      const context = getContext();
      const manager = context?.terminalSessions;
      if (!context || !manager) {
        throw new ToolInputError("terminal unavailable");
      }

      if (action === "list") {
        return jsonResult({ sessions: manager.listAgent(agentSessionKey) });
      }

      if (action === "open") {
        const command = readOptionalString(params, "command", { trim: false });
        const cwd = readOptionalString(params, "cwd");
        const cols = readDimension(params, "cols", DEFAULT_COLS);
        const rows = readDimension(params, "rows", DEFAULT_ROWS);
        const show = readShow(params);
        if (!context.isTerminalEnabled()) {
          throw new ToolInputError("terminal disabled");
        }
        const agentId = opts.agentId?.trim() || resolveAgentIdFromSessionKey(agentSessionKey);
        const launch = context.resolveTerminalLaunchPolicy(agentId);
        if (!launch.ok) {
          throw new ToolInputError(launchBlockMessage(launch.block));
        }
        const spawnPlan = resolveTerminalSpawnPlan({
          ...launch.plan,
          ...(cwd ? { cwdOverride: cwd } : {}),
        });
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
              owner: { kind: "agent", agentSessionKey },
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
                  manager.closeAgent(agentSessionKey, lateOutcome.sessionId);
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
        if (
          command !== undefined &&
          !manager.writeAgent(agentSessionKey, outcome.sessionId, `${command}\r`)
        ) {
          manager.closeAgent(agentSessionKey, outcome.sessionId);
          throw new ToolInputError("terminal command failed");
        }
        if (show) {
          const uiCommand: UiCommandParams = {
            command: {
              kind: "panel",
              panel: "terminal",
              open: true,
              terminalSessionId: outcome.sessionId,
            },
            sessionKey: agentSessionKey,
          };
          try {
            await gatewayCall("ui.command", uiCommand);
          } catch {
            // Terminal remains useful when no capable Control UI is connected.
          }
        }
        return jsonResult(outcome);
      }

      const sessionId = requireSessionId(params);
      if (action === "read") {
        const raw = manager.snapshotAgent(agentSessionKey, sessionId);
        if (raw === undefined) {
          throw new ToolInputError("terminal not owned by this agent session");
        }
        return jsonResult({ sessionId, text: renderTerminalBufferText(raw) });
      }
      if (action === "input") {
        const data = readStringParam(params, "data", {
          required: true,
          trim: false,
          allowEmpty: true,
        });
        return jsonResult({ ok: manager.writeAgent(agentSessionKey, sessionId, data) });
      }
      if (action === "resize") {
        return jsonResult({
          ok: manager.resizeAgent(
            agentSessionKey,
            sessionId,
            readDimension(params, "cols"),
            readDimension(params, "rows"),
          ),
        });
      }
      if (action === "close") {
        return jsonResult({ ok: manager.closeAgent(agentSessionKey, sessionId) });
      }
      throw new ToolInputError(`Unknown action: ${action}`);
    },
  };
}
