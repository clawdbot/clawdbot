// Runtime env override facade keeps env override loading behind a lazy boundary.
import { getActiveSkillEnvKeys as getActiveSkillEnvKeysImpl } from "./env-overrides.js";

type GetActiveSkillEnvKeys = typeof import("./env-overrides.js").getActiveSkillEnvKeys;

/** Runtime facade for active skill env override discovery. */
export function getActiveSkillEnvKeys(
  ...args: Parameters<GetActiveSkillEnvKeys>
): ReturnType<GetActiveSkillEnvKeys> {
  return getActiveSkillEnvKeysImpl(...args);
}
