// Skill tools directory helpers resolve local tool paths exposed to skill runtimes.
import path from "node:path";
import { safePathSegmentHashed } from "../../infra/install-safe-path.js";
import { resolveConfigDir } from "../../utils.js";
import { resolveSkillKey } from "../loading/frontmatter.js";
import type { SkillEntry } from "../types.js";

/** Resolves a skill's tools directory relative to the OpenClaw config dir. */
export function resolveSkillToolsRootDir(entry: SkillEntry): string {
  const key = resolveSkillKey(entry.skill, entry);
  const safeKey = safePathSegmentHashed(key);
  return path.join(resolveConfigDir(), "tools", safeKey);
}
