/** Pure helpers for doctor skill readiness repairs. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SkillStatusEntry, SkillStatusReport } from "../skills/discovery/status.js";

/** Returns allowed skills that are unusable in the current runtime environment. */
export function collectUnavailableAgentSkills(report: SkillStatusReport): SkillStatusEntry[] {
  return report.skills.filter(
    (skill) =>
      !skill.eligible &&
      !skill.disabled &&
      !skill.blockedByAllowlist &&
      !skill.blockedByAgentFilter,
  );
}

/** Disables unavailable skills in config while preserving existing skill entries. */
export function disableUnavailableSkillsInConfig(
  config: OpenClawConfig,
  skills: readonly SkillStatusEntry[],
): OpenClawConfig {
  if (skills.length === 0) {
    return config;
  }
  const entries = { ...config.skills?.entries };
  for (const skill of skills) {
    entries[skill.skillKey] = {
      ...entries[skill.skillKey],
      enabled: false,
    };
  }
  return {
    ...config,
    skills: {
      ...config.skills,
      entries,
    },
  };
}
