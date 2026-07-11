import { AsyncLocalStorage } from "node:async_hooks";
import type { AnyAgentTool } from "./tools/common.js";

type AgentRingZeroToolScope = {
  active: boolean;
  tools: readonly AnyAgentTool[];
};

const activeRingZeroTools = new AsyncLocalStorage<AgentRingZeroToolScope>();

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return false;
  }
  return "then" in value && typeof value.then === "function";
}

class HostScopedAgentToolAuthorizationError extends Error {
  readonly status = 403;

  constructor(message: string) {
    super(message);
    this.name = "HostScopedAgentToolAuthorizationError";
  }
}

function bindToolToScope(tool: AnyAgentTool, scope: AgentRingZeroToolScope): AnyAgentTool {
  const execute = tool.execute;
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      // Plugins receive executable tool handles, so revoking discovery alone
      // is insufficient. Possession remains valid while the harness promise is
      // active because SDK callbacks can run on async resources created outside
      // this ALS store; every retained handle fails after run settlement.
      if (!scope.active) {
        throw new HostScopedAgentToolAuthorizationError(
          `host-scoped tool "${tool.name}" is no longer authorized for this run`,
        );
      }
      return await execute(toolCallId, params, signal, onUpdate);
    },
  };
}

/**
 * Bind host-owned tools to one selected harness run. The SDK reads this scope
 * during tool construction, so plugins never receive private authority objects.
 */
export function runWithAgentRingZeroTools<T>(tools: readonly AnyAgentTool[], run: () => T): T {
  const scope: AgentRingZeroToolScope = { active: true, tools: [] };
  scope.tools = tools.map((tool) => bindToolToScope(tool, scope));
  try {
    const result = activeRingZeroTools.run(scope, run);
    if (isPromiseLike(result)) {
      return Promise.resolve(result).finally(() => {
        scope.active = false;
      }) as T;
    }
    scope.active = false;
    return result;
  } catch (error) {
    scope.active = false;
    throw error;
  }
}

/** Read the host-owned tools bound to the current harness run. */
export function getActiveAgentRingZeroTools(): readonly AnyAgentTool[] {
  const scope = activeRingZeroTools.getStore();
  return scope?.active === true ? scope.tools : [];
}

/**
 * Read a host-owned tool fact for the current run. This does not activate or
 * grant a tool; only the host can bind executable authority to the run scope.
 */
export function isHostScopedAgentToolActive(toolName: string): boolean {
  const normalizedName = toolName.trim().toLowerCase();
  return (
    normalizedName.length > 0 &&
    getActiveAgentRingZeroTools().some((tool) => tool.name.trim().toLowerCase() === normalizedName)
  );
}
