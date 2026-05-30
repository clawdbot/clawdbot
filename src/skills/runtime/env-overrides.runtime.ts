import { getActiveSkillEnvKeys as getActiveSkillEnvKeysImpl } from "./env-overrides.js";

type GetActiveSkillEnvKeys = typeof import("./env-overrides.js").getActiveSkillEnvKeys;

export function getActiveSkillEnvKeys(
  ...args: Parameters<GetActiveSkillEnvKeys>
): ReturnType<GetActiveSkillEnvKeys> {
  return getActiveSkillEnvKeysImpl(...args);
}
