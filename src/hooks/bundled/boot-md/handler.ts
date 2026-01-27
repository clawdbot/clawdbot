import type { CliDeps } from "../../../cli/deps.js";
import { createDefaultDeps } from "../../../cli/deps.js";
import type { MoltbotConfig } from "../../../config/config.js";
import { runBootOnce } from "../../../gateway/boot.js";
import type { HookHandler } from "../../hooks.js";

type BootHookContext = {
  cfg?: MoltbotConfig;
  workspaceDir?: string;
  deps?: CliDeps;
};

const runBootChecklist: HookHandler = async (event) => {
  if (event.type !== "gateway" || event.action !== "startup") {
    return;
  }

  const context = (event.context ?? {}) as BootHookContext;
  if (!context.cfg || !context.workspaceDir) {
    return;
  }

  const deps = context.deps ?? createDefaultDeps();
  await runBootOnce({ cfg: context.cfg, deps, workspaceDir: context.workspaceDir });
};

export default runBootChecklist;
