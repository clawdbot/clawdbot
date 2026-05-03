import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { SkillStatusEntry, SkillStatusReport } from "../agents/skills-status.js";
import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { note } from "../terminal/note.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

export function collectUnavailableAgentSkills(report: SkillStatusReport): SkillStatusEntry[] {
  return report.skills.filter(
    (skill) =>
      !skill.eligible &&
      !skill.disabled &&
      !skill.blockedByAllowlist &&
      !skill.blockedByAgentFilter,
  );
}

function formatMissingSummary(skill: SkillStatusEntry): string {
  const missing: string[] = [];
  if (skill.missing.bins.length > 0) {
    missing.push(`bins: ${skill.missing.bins.join(", ")}`);
  }
  if (skill.missing.anyBins.length > 0) {
    missing.push(`any bins: ${skill.missing.anyBins.join(", ")}`);
  }
  if (skill.missing.env.length > 0) {
    missing.push(`env: ${skill.missing.env.join(", ")}`);
  }
  if (skill.missing.config.length > 0) {
    missing.push(`config: ${skill.missing.config.join(", ")}`);
  }
  if (skill.missing.os.length > 0) {
    missing.push(`os: ${skill.missing.os.join(", ")}`);
  }
  return missing.join("; ") || "unknown requirement";
}

function formatInstallHints(skill: SkillStatusEntry): string[] {
  if (skill.install.length === 0) {
    return [];
  }
  return skill.install.slice(0, 2).map((entry) => `  install option: ${entry.label}`);
}

export function formatUnavailableSkillDoctorLines(skills: SkillStatusEntry[]): string[] {
  const lines: string[] = [
    "Some skills are allowed for this agent but are not usable in the current runtime environment.",
  ];
  for (const skill of skills) {
    lines.push(`- ${skill.name}: ${formatMissingSummary(skill)}`);
    lines.push(...formatInstallHints(skill));
  }
  lines.push(`Disable unused skills: ${formatCliCommand("openclaw doctor --fix")}`);
  lines.push(
    `Inspect details: ${formatCliCommand("openclaw skills check --agent <id>")} or ${formatCliCommand("openclaw skills info <name> --agent <id>")}`,
  );
  return lines;
}

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

export async function maybeRepairSkillReadiness(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
}): Promise<OpenClawConfig> {
  const agentId = resolveDefaultAgentId(params.cfg);
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
  const report = buildWorkspaceSkillStatus(workspaceDir, {
    config: params.cfg,
    agentId,
  });
  const unavailable = collectUnavailableAgentSkills(report);
  if (unavailable.length === 0) {
    return params.cfg;
  }

  note(formatUnavailableSkillDoctorLines(unavailable).join("\n"), "Skills");
  const shouldDisable = await params.prompter.confirmAutoFix({
    message: `Disable ${unavailable.length} unavailable skill${unavailable.length === 1 ? "" : "s"} in config?`,
    initialValue: false,
  });
  if (!shouldDisable) {
    return params.cfg;
  }

  const next = disableUnavailableSkillsInConfig(params.cfg, unavailable);
  note(unavailable.map((skill) => `- Disabled ${skill.name}`).join("\n"), "Doctor changes");
  return next;
}
