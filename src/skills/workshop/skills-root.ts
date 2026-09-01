import path from "node:path";
import { resolveConfigDir } from "../../utils.js";

/** Skill Workshop owns this one global tree. */
export function resolveWorkshopSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveConfigDir(env), "workshop-skills");
}
