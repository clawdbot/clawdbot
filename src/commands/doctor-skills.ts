/** Doctor checks and repair prompts for unavailable configured skills. */
import { existsSync } from "node:fs";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SkillStatusEntry } from "../skills/discovery/status.js";
import { buildWorkspaceSkillStatus } from "../skills/discovery/status.js";
import {
  detectGhConfigDirMismatch,
  formatGhConfigDirMismatchHint,
  type GhConfigDiscoveryInput,
  type GhConfigDiscoveryResult,
} from "../skills/lifecycle/gh-config-discovery.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  collectUnavailableAgentSkills,
  disableUnavailableSkillsInConfig,
} from "./doctor-skills-core.js";

function defaultGhConfigDiscoveryInput(): GhConfigDiscoveryInput {
  return {
    platform: process.platform,
    env: process.env as GhConfigDiscoveryInput["env"],
    fileExists: (absolutePath) => existsSync(absolutePath),
  };
}

/** Builds a GitHub CLI config-dir hint for eligible GitHub skill setups. */
function describeGhConfigDirHint(skills: SkillStatusEntry[]): string[] {
  return describeGhConfigDirHintFromDiscovery(skills, defaultGhConfigDiscoveryInput());
}

/** Builds a GitHub CLI config-dir hint from injected discovery inputs for tests. */
function describeGhConfigDirHintFromDiscovery(
  skills: SkillStatusEntry[],
  discoveryInput: GhConfigDiscoveryInput,
): string[] {
  const githubSkill = skills.find((skill) => skill.name === "github");
  if (!githubSkill) {
    return [];
  }
  if (
    !githubSkill.eligible ||
    githubSkill.blockedByAgentFilter ||
    githubSkill.disabled ||
    githubSkill.blockedByAllowlist
  ) {
    return [];
  }
  const result: GhConfigDiscoveryResult = detectGhConfigDirMismatch(discoveryInput);
  if (result.kind !== "mismatch") {
    return [];
  }
  return formatGhConfigDirMismatchHint(result);
}

/** Formats doctor note lines for skills that are allowed but unavailable. */
function formatUnavailableSkillDoctorLines(skills: SkillStatusEntry[]): string[] {
  const count = skills.length;
  const lines = [
    `${count} allowed skill${count === 1 ? " is" : "s are"} not usable in this environment (missing binaries, env vars, or config).`,
    `- ${skills
      .map((skill) => skill.name)
      .toSorted((a, b) => a.localeCompare(b))
      .join(", ")}`,
  ];
  lines.push(`Disable unused skills: ${formatCliCommand("openclaw doctor --fix")}`);
  lines.push(
    `Inspect details: ${formatCliCommand("openclaw skills check --agent <id>")} or ${formatCliCommand("openclaw skills info <name> --agent <id>")}`,
  );
  return lines;
}

/** Checks default-agent skill readiness and optionally disables unavailable skills in config. */
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
  const githubHint = describeGhConfigDirHint(report.skills);
  if (githubHint.length > 0) {
    note(githubHint.join("\n"), "GitHub CLI");
  }
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
