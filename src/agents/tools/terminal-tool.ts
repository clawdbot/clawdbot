import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { renderTerminalBufferText } from "../../gateway/terminal/buffer-text.js";
import type { TerminalAgentActionOutcome } from "../../gateway/terminal/session-manager.types.js";
import { getActiveAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import type { ExecMode } from "../../infra/exec-approvals.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  registerExecApprovalRequestForHostOrThrow,
  resolveRegisteredExecApprovalDecision,
} from "../bash-tools.exec-approval-request.js";
import {
  resolveExecDefaults,
  type ExecPolicyOverrides,
  type ExecSessionDefaults,
} from "../exec-defaults.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readPositiveIntegerParam,
  readToolStringParam,
  ToolInputError,
} from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { getInProcessGatewayToolContext } from "./in-process-gateway.js";

const ACTIONS = ["read", "list", "resize", "close", "input"] as const;
const MAX_DIMENSION = 2000;

const TerminalToolSchema = Type.Object(
  {
    action: Type.String({ enum: [...ACTIONS], description: "Action" }),
    sessionId: Type.Optional(Type.String({ description: "Shared terminal session" })),
    data: Type.Optional(Type.String({ description: "Exact terminal input" })),
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
  Type.Object({ sessionId: Type.String(), text: Type.String() }, { additionalProperties: false }),
  Type.Object({ ok: Type.Literal(true) }, { additionalProperties: false }),
]);

const TERMINAL_RECOVERY_GUIDANCE =
  "Use action=list to find a shared terminal or ask the operator to open one in this chat.";
const TERMINAL_UNAVAILABLE_MESSAGE = `Terminal session unavailable. ${TERMINAL_RECOVERY_GUIDANCE}`;

type TerminalToolGatewayContext = Pick<GatewayRequestContext, "terminalSessions">;

type TerminalToolOptions = {
  agentId?: string;
  agentSessionKey?: string;
  sessionId?: string;
  config?: OpenClawConfig;
  execSession?: ExecSessionDefaults;
  execOverrides?: ExecPolicyOverrides & { mode?: ExecMode };
  runId?: string;
  approvalReviewerDeviceIds?: string[];
  getGatewayContext?: () => TerminalToolGatewayContext | undefined;
};

function terminalActionResult(
  action: "input" | "resize" | "close",
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

function readDimension(params: Record<string, unknown>, key: "cols" | "rows"): number {
  const value = readPositiveIntegerParam(params, key, {
    max: MAX_DIMENSION,
    message: `${key} must be an integer from 1 to ${MAX_DIMENSION}`,
  });
  if (value === undefined) {
    throw new ToolInputError(`${key} required`);
  }
  return value;
}

export function createTerminalTool(opts: TerminalToolOptions = {}): AnyAgentTool {
  return {
    label: "Terminal",
    name: "terminal",
    description:
      "Manage terminals the operator opened from this chat's Control UI panel. list discovers shared terminals; read returns a buffer snapshot; resize and close manage an existing terminal; input requires one-time operator approval unless the execution policy permits unrestricted access.",
    parameters: TerminalToolSchema,
    outputSchema: TerminalToolOutputSchema,
    execute: async (toolCallId, rawArgs, signal) => {
      const params = rawArgs as Record<string, unknown>;
      const action = readToolStringParam(params, "action", { required: true });
      if (!ACTIONS.some((candidate) => candidate === action)) {
        throw new ToolInputError(
          "terminal action unavailable; use list, read, resize, close, or input",
        );
      }
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
      const callerIdentity = getGatewayToolCallerIdentity();
      const admittedResolver = opts.getGatewayContext
        ? undefined
        : callerIdentity?.gatewayContextResolver;
      const getContext =
        opts.getGatewayContext ?? admittedResolver ?? getInProcessGatewayToolContext;
      const context = getContext();
      const manager = context?.terminalSessions;
      if (!context || !manager) {
        throw new ToolInputError("terminal unavailable");
      }

      if (action === "list") {
        return jsonResult({ sessions: manager.listAgent(owner) });
      }

      const sessionId = readToolStringParam(params, "sessionId", { required: true });
      if (action === "read") {
        const raw = manager.snapshotAgent(owner, sessionId);
        if (raw === undefined) {
          throw new ToolInputError(TERMINAL_UNAVAILABLE_MESSAGE);
        }
        return jsonResult({ sessionId, text: renderTerminalBufferText(raw) });
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

      const data = readToolStringParam(params, "data", {
        required: true,
        trim: false,
        allowEmpty: true,
      });
      let execSession = opts.execSession;
      if (!execSession) {
        const { loadGatewaySessionEntryReadOnly } =
          await import("../../gateway/session-utils-store.js");
        const entry = loadGatewaySessionEntryReadOnly(agentSessionKey, {
          agentId,
          clone: false,
        }).entry;
        if (!entry || entry.sessionId?.trim() !== agentSessionId) {
          throw new ToolInputError(TERMINAL_UNAVAILABLE_MESSAGE);
        }
        execSession = entry;
        // A lazy policy read may cross Gateway retirement; the replacement
        // manager cannot inherit authority over this already-captured PTY.
        if (getContext()?.terminalSessions !== manager) {
          throw new ToolInputError(TERMINAL_UNAVAILABLE_MESSAGE);
        }
      }
      const policy = resolveExecDefaults({
        cfg: opts.config,
        sessionEntry: execSession,
        execOverrides: opts.execOverrides,
        agentId,
        sessionKey: agentSessionKey,
      });
      if (policy.mode === "deny") {
        throw new ToolInputError("Terminal input denied by execution policy");
      }
      const operationalRunInstance = callerIdentity?.operationalRunInstance;
      const delegatedAuthority = operationalRunInstance
        ? getActiveAgentRunDelegatedAuthority(operationalRunInstance)
        : undefined;
      if (
        !operationalRunInstance ||
        !delegatedAuthority ||
        callerIdentity?.receiptAuthority?.() === false
      ) {
        throw new ToolInputError("Terminal input denied: agent run is no longer active");
      }
      if (manager.snapshotAgent(owner, sessionId) === undefined) {
        throw new ToolInputError(TERMINAL_UNAVAILABLE_MESSAGE);
      }

      if (policy.mode !== "full") {
        const registration = await registerExecApprovalRequestForHostOrThrow({
          approvalId: randomUUID(),
          command: `Terminal input: ${JSON.stringify(data)}`,
          workdir: undefined,
          host: "gateway",
          security: policy.security,
          ask: "always",
          unavailableDecisions: ["allow-always"],
          warningText: "Allow the agent to send this exact input to an existing shared terminal.",
          agentId,
          sessionKey: agentSessionKey,
          sessionId: agentSessionId,
          runId: operationalRunInstance.runId,
          toolCallId,
          ...(opts.approvalReviewerDeviceIds?.length
            ? { approvalReviewerDeviceIds: opts.approvalReviewerDeviceIds }
            : {}),
          requireDeliveryRoute: true,
        });
        const decision = await resolveRegisteredExecApprovalDecision({
          approvalId: registration.id,
          preResolvedDecision: registration.finalDecision,
        });
        if (decision !== "allow-once") {
          throw new ToolInputError("Terminal input denied: operator approval required");
        }
      }
      signal?.throwIfAborted();
      // Every write, including unprompted Full access, is bound to its exact live
      // run and Gateway immediately before synchronous PTY I/O.
      if (
        getActiveAgentRunDelegatedAuthority(operationalRunInstance) !== delegatedAuthority ||
        callerIdentity.receiptAuthority?.() === false
      ) {
        throw new ToolInputError("Terminal input denied: agent run is no longer active");
      }
      if (getContext()?.terminalSessions !== manager) {
        throw new ToolInputError(TERMINAL_UNAVAILABLE_MESSAGE);
      }
      return terminalActionResult("input", manager.writeAgent(owner, sessionId, data));
    },
  };
}
