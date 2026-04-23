import { listAgentIds, resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import { createDefaultDeps } from "../../../cli/deps.js";
import { runBootOnce } from "../../../gateway/boot.js";
import { runStartupTasks, type StartupTask } from "../../../gateway/startup-tasks.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { isGatewayStartupEvent } from "../../internal-hooks.js";

const log = createSubsystemLogger("hooks/boot-md");

const runBootChecklist: HookHandler = async (event) => {
  if (!isGatewayStartupEvent(event)) {
    return;
  }

  if (!event.context.cfg) {
    return;
  }

  const cfg = event.context.cfg;
  const deps = event.context.deps ?? createDefaultDeps();
  const tasks: StartupTask[] = listAgentIds(cfg).map((agentId) => {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    return {
      source: "boot-md",
      agentId,
      workspaceDir,
      run: () => runBootOnce({ cfg, deps, workspaceDir, agentId }),
    };
  });

  await runStartupTasks({ tasks, log });
};

export default runBootChecklist;
