import type { ExecPolicyOverrides } from "../../agents/exec-defaults.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillCommandSpec } from "../../skills/types.js";
import type { HandleCommandsParams } from "./commands-types.js";

type SkillCommandsRuntime = typeof import("../../skills/discovery/chat-commands.runtime.js");

export function createSkillCommandLoaders(
  loadRuntime: () => Promise<SkillCommandsRuntime>,
  params: {
    workspaceDir: string;
    cfg: OpenClawConfig;
    agentId?: string;
    skillFilter?: string[];
    sessionEntry?: SessionEntry;
    sessionKey?: string;
    execOverrides?: ExecPolicyOverrides;
    loadSkillCommands?: () => Promise<SkillCommandSpec[]>;
  },
): Pick<HandleCommandsParams, "loadSkillCommands" | "loadBundledSkillCommand"> {
  const context = {
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    agentId: params.agentId,
    skillFilter: params.skillFilter,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    execOverrides: params.execOverrides,
  };
  return {
    loadSkillCommands:
      params.loadSkillCommands ??
      (async () => (await loadRuntime()).listSkillCommandsForWorkspace(context)),
    loadBundledSkillCommand: async (skillName) =>
      (await loadRuntime()).findBundledSkillCommandForWorkspace({
        ...context,
        skillName,
      }),
  };
}
