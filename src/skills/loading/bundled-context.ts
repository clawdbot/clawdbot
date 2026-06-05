// Bundled context helpers resolve bundled skill paths and logging for skill loading.
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveBundledSkillsDir, type BundledSkillsResolveOptions } from "./bundled-dir.js";
import { loadSkillsFromDirSafe } from "./local-loader.js";

const skillsLogger = createSubsystemLogger("skills");
let hasWarnedMissingBundledDir = false;
let cachedBundledContext: { dir: string; names: Set<string> } | null = null;

/** Bundled skill path context resolved from runtime defaults. */
export type BundledSkillsContext = {
  dir?: string;
  names: Set<string>;
};

export function resolveBundledSkillsContext(
  opts: BundledSkillsResolveOptions = {},
): BundledSkillsContext {
  const dir = resolveBundledSkillsDir(opts);
  const names = new Set<string>();
  if (!dir) {
    if (!hasWarnedMissingBundledDir) {
      hasWarnedMissingBundledDir = true;
      skillsLogger.warn(
        "Bundled skills directory could not be resolved; built-in skills may be missing.",
      );
    }
    return { dir, names };
  }

  if (cachedBundledContext?.dir === dir) {
    return { dir, names: new Set(cachedBundledContext.names) };
  }
  // Bundled skill metadata is process-stable; cache names until restart.
  const result = loadSkillsFromDirSafe({ dir, source: "openclaw-bundled" });
  for (const skill of result.skills) {
    if (skill.name.trim()) {
      names.add(skill.name);
    }
  }
  cachedBundledContext = { dir, names: new Set(names) };
  return { dir, names };
}
