import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PluginHookAgentEndEvent,
  PluginHookBeforeAgentFinalizeEvent,
  PluginHookBeforeAgentFinalizeResult,
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
} from "../../plugins/hook-types.js";
import { buildAgentHookContext, type AgentHarnessHookContext } from "./hook-context.js";

const log = createSubsystemLogger("agents/harness");

type AgentHarnessHookRunner = ReturnType<typeof getGlobalHookRunner>;

export function runAgentHarnessLlmInputHook(params: {
  event: PluginHookLlmInputEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): void {
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("llm_input")) {
    return;
  }
  void hookRunner.runLlmInput(params.event, buildAgentHookContext(params.ctx)).catch((error) => {
    log.warn(`llm_input hook failed: ${String(error)}`);
  });
}

export function runAgentHarnessLlmOutputHook(params: {
  event: PluginHookLlmOutputEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): void {
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("llm_output")) {
    return;
  }
  void hookRunner.runLlmOutput(params.event, buildAgentHookContext(params.ctx)).catch((error) => {
    log.warn(`llm_output hook failed: ${String(error)}`);
  });
}

export function runAgentHarnessAgentEndHook(params: {
  event: PluginHookAgentEndEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): void {
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("agent_end")) {
    return;
  }
  void hookRunner.runAgentEnd(params.event, buildAgentHookContext(params.ctx)).catch((error) => {
    log.warn(`agent_end hook failed: ${String(error)}`);
  });
}

export type AgentHarnessBeforeAgentFinalizeOutcome =
  | { action: "continue" }
  | { action: "revise"; reason: string }
  | { action: "finalize"; reason?: string };

export async function runAgentHarnessBeforeAgentFinalizeHook(params: {
  event: PluginHookBeforeAgentFinalizeEvent;
  ctx: AgentHarnessHookContext;
  hookRunner?: AgentHarnessHookRunner;
}): Promise<AgentHarnessBeforeAgentFinalizeOutcome> {
  const hookRunner = params.hookRunner ?? getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_agent_finalize")) {
    return { action: "continue" };
  }
  try {
    return normalizeBeforeAgentFinalizeResult(
      await hookRunner.runBeforeAgentFinalize(params.event, buildAgentHookContext(params.ctx)),
    );
  } catch (error) {
    log.warn(`before_agent_finalize hook failed: ${String(error)}`);
    return { action: "continue" };
  }
}

function normalizeBeforeAgentFinalizeResult(
  result: PluginHookBeforeAgentFinalizeResult | undefined,
): AgentHarnessBeforeAgentFinalizeOutcome {
  if (result?.action === "finalize") {
    return result.reason?.trim()
      ? { action: "finalize", reason: result.reason.trim() }
      : { action: "finalize" };
  }
  if (result?.action === "revise") {
    const reason = result.reason?.trim();
    return reason ? { action: "revise", reason } : { action: "continue" };
  }
  return { action: "continue" };
}
