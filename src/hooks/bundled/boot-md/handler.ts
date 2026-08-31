// Boot.md hook injects workspace boot notes into agent startup context.
import { listAgentIds, resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import { createDefaultDeps } from "../../../cli/deps.js";
import { runBootOnce } from "../../../gateway/boot.js";
import { runStartupTasks, type StartupTask } from "../../../gateway/startup-tasks.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { isGatewayStartupEvent } from "../../internal-hooks.js";

const log = createSubsystemLogger("hooks/boot-md");

/** Gateway-startup hook that runs BOOT.md checks once per unique agent workspace. */
const runBootChecklist: HookHandler = async (event) => {
  if (!isGatewayStartupEvent(event)) {
    return;
  }

  if (!event.context.cfg) {
    return;
  }

  const cfg = event.context.cfg;
  const deps = event.context.deps ?? createDefaultDeps();
  const seenWorkspaces = new Set<string>();
  // Multiple agents may share a workspace. Startup tasks are keyed by workspace
  // so BOOT.md is not executed repeatedly for the same files.
  const tasks: StartupTask[] = listAgentIds(cfg)
    .map((agentId) => {
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      return { agentId, workspaceDir };
    })
    .filter(({ workspaceDir }) => {
      if (seenWorkspaces.has(workspaceDir)) {
        return false;
      }
      seenWorkspaces.add(workspaceDir);
      return true;
    })
    .map(({ agentId, workspaceDir }) => ({
      source: "boot-md" as const,
      agentId,
      workspaceDir,
      run: () => runBootOnce({ cfg, deps, workspaceDir, agentId }),
    }));

  await runStartupTasks({ tasks, log });
};

export default runBootChecklist;
