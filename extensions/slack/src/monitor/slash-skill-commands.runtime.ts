import { listSkillCommandsForAgents as listSkillCommandsForAgentsImpl } from "openclaw/plugin-sdk/command-auth";

type ListSkillCommandsForAgents =
  typeof import("openclaw/plugin-sdk/command-auth").listSkillCommandsForAgents;

export function listSkillCommandsForAgents(
  ...args: Parameters<ListSkillCommandsForAgents>
): ReturnType<ListSkillCommandsForAgents> {
  return listSkillCommandsForAgentsImpl(...args);
}
