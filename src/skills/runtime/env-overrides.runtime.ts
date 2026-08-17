// Runtime env override facade keeps env override loading behind a lazy boundary.
import { getActiveSkillEnvKeysCore } from "./env-overrides.js";

type GetActiveSkillEnvKeys = typeof import("./env-overrides.js").getActiveSkillEnvKeysCore;

/** Runtime facade for active skill env override discovery. */
export function getActiveSkillEnvKeys(
  ...args: Parameters<GetActiveSkillEnvKeys>
): ReturnType<GetActiveSkillEnvKeys> {
  return getActiveSkillEnvKeysCore(...args);
}
