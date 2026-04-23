import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PluginHookAgentEndEvent,
  PluginHookAgentContext,
  PluginHookLlmInputEvent,
  PluginHookLlmOutputEvent,
} from "../../plugins/hook-types.js";

const log = createSubsystemLogger("agents/harness");

type AgentHarnessHookContext = {
  runId: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
};

function buildAgentHookContext(params: AgentHarnessHookContext): PluginHookAgentContext {
  return {
    runId: params.runId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.messageProvider ? { messageProvider: params.messageProvider } : {}),
    ...(params.trigger ? { trigger: params.trigger } : {}),
    ...(params.channelId ? { channelId: params.channelId } : {}),
  };
}

export function runAgentHarnessLlmInputHook(params: {
  event: PluginHookLlmInputEvent;
  ctx: AgentHarnessHookContext;
}): void {
  const hookRunner = getGlobalHookRunner();
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
}): void {
  const hookRunner = getGlobalHookRunner();
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
}): void {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("agent_end")) {
    return;
  }
  void hookRunner.runAgentEnd(params.event, buildAgentHookContext(params.ctx)).catch((error) => {
    log.warn(`agent_end hook failed: ${String(error)}`);
  });
}
