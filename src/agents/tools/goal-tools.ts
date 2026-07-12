/**
 * Model-facing thread goal tools.
 *
 * Provides create/get/update goal operations scoped to the current session store.
 */
import { Type } from "typebox";
import {
  createSessionGoal,
  getSessionGoal,
  MODEL_UPDATABLE_SESSION_GOAL_STATUSES,
  updateSessionGoalStatus,
} from "../../config/sessions/goals.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  ToolInputError,
  jsonResult,
  readPositiveIntegerParam,
  readStringParam,
} from "./common.js";

type GoalToolOptions = {
  agentSessionKey?: string;
  runSessionKey?: string;
  sessionAgentId?: string;
  config?: OpenClawConfig;
};

type GoalSessionScope = {
  sessionKey: string;
  agentId: string;
  storePath: string;
};

const CreateGoalToolSchema = Type.Object({
  objective: Type.String({
    description: "Concrete objective to pursue. Create only when explicitly requested.",
  }),
  token_budget: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Optional positive token budget for this goal.",
    }),
  ),
});

const UpdateGoalToolSchema = Type.Object({
  status: stringEnum(MODEL_UPDATABLE_SESSION_GOAL_STATUSES, {
    description: "complete | blocked.",
  }),
  note: Type.Optional(Type.String({ description: "Short status note." })),
});

function resolveGoalSessionScope(options: GoalToolOptions): GoalSessionScope {
  const sessionKey = options.runSessionKey?.trim() || options.agentSessionKey?.trim();
  if (!sessionKey) {
    throw new ToolInputError("session key required");
  }
  const parsedSessionAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  const parsedAgentSessionAgentId = parseAgentSessionKey(options.agentSessionKey)?.agentId;
  // Prefer the run session's agent id; fall back to the agent session for legacy tool contexts.
  const agentId = normalizeAgentId(
    parsedSessionAgentId ?? parsedAgentSessionAgentId ?? options.sessionAgentId,
  );
  return {
    sessionKey,
    agentId,
    storePath: resolveStorePath(options.config?.session?.store, {
      agentId,
    }),
  };
}

/** Creates the read-only tool that returns the current thread goal snapshot. */
export function createGetGoalTool(options: GoalToolOptions): AnyAgentTool {
  return {
    label: "Get Goal",
    name: "get_goal",
    displaySummary: "Get the current thread goal",
    description: "Get the current goal for this thread, including status and token usage.",
    parameters: Type.Object({}),
    execute: async () => {
      const snapshot = await getSessionGoal({
        ...resolveGoalSessionScope(options),
        persist: false,
      });
      return jsonResult(snapshot);
    },
  };
}

/** Creates the tool that starts a new thread goal when explicitly requested. */
export function createCreateGoalTool(options: GoalToolOptions): AnyAgentTool {
  return {
    label: "Create Goal",
    name: "create_goal",
    displaySummary: "Create a thread goal",
    description:
      "Create a goal only when explicitly requested by the user or system instructions. Fails if a goal already exists; use user-facing goal controls to clear it.",
    parameters: CreateGoalToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const objective = readStringParam(params, "objective", { required: true });
      const tokenBudget = readPositiveIntegerParam(params, "token_budget", {
        message: "token_budget must be a positive integer",
      });
      const scope = resolveGoalSessionScope(options);
      const goal = await createSessionGoal({
        ...scope,
        actor: { type: "agent", id: scope.sessionKey },
        objective,
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      });
      return jsonResult({ status: "created", goal });
    },
  };
}

/** Creates the tool that marks the current thread goal complete or blocked. */
export function createUpdateGoalTool(options: GoalToolOptions): AnyAgentTool {
  return {
    label: "Update Goal",
    name: "update_goal",
    displaySummary: "Complete or block a thread goal",
    description:
      "Mark the current goal complete only when achieved, or blocked only after the same blocking condition recurs for at least three consecutive goal turns. Do not use blocked for ordinary difficulty or missing polish.",
    parameters: UpdateGoalToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const status = readStringParam(params, "status", { required: true });
      if (
        !MODEL_UPDATABLE_SESSION_GOAL_STATUSES.includes(
          status as (typeof MODEL_UPDATABLE_SESSION_GOAL_STATUSES)[number],
        )
      ) {
        throw new ToolInputError(
          `status must be one of ${MODEL_UPDATABLE_SESSION_GOAL_STATUSES.join(", ")}`,
        );
      }
      const note = readStringParam(params, "note");
      const scope = resolveGoalSessionScope(options);
      const goal = await updateSessionGoalStatus({
        ...scope,
        actor: { type: "agent", id: scope.sessionKey },
        status: status as (typeof MODEL_UPDATABLE_SESSION_GOAL_STATUSES)[number],
        ...(note ? { note } : {}),
      });
      return jsonResult({ status: "updated", goal });
    },
  };
}
