/** Doctor checks and repair prompts for unavailable configured skills. */
import { existsSync } from "node:fs";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
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
function formatUnavailableSkillDoctorLines(
  skills: SkillStatusEntry[],
  includeDisableHint = true,
): string[] {
  const count = skills.length;
  const lines = [
    `${count} allowed skill${count === 1 ? " is" : "s are"} not usable in this environment (missing binaries, env vars, or config).`,
    `- ${skills
      .map((skill) => skill.name)
      .toSorted((a, b) => a.localeCompare(b))
      .join(", ")}`,
  ];
  if (includeDisableHint) {
    lines.push(`Disable unused skills: ${formatCliCommand("openclaw doctor --fix")}`);
  }
  lines.push(
    `Inspect details: ${formatCliCommand("openclaw skills check --agent <id>")} or ${formatCliCommand("openclaw skills info <name> --agent <id>")}`,
  );
  return lines;
}

function collectFleetUnavailableSkills(
  reports: Array<{ unavailable: SkillStatusEntry[]; skills: SkillStatusEntry[] }>,
): SkillStatusEntry[] {
  const healthyKeys = new Set(
    reports.flatMap(({ skills }) =>
      skills
        .filter((skill) => skill.eligible && !skill.blockedByAgentFilter)
        .map((skill) => skill.skillKey),
    ),
  );
  const candidates = new Map<string, SkillStatusEntry>();
  for (const skill of reports.flatMap(({ unavailable }) => unavailable)) {
    if (!healthyKeys.has(skill.skillKey)) {
      candidates.set(skill.skillKey, skill);
    }
  }
  return [...candidates.values()];
}

/** Checks every agent's skill readiness and disables only fleet-wide unavailable skills. */
export async function maybeRepairSkillReadiness(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
}): Promise<OpenClawConfig> {
  const agentIds = listAgentIds(params.cfg);
  const scopes = agentIds.map((agentId) => ({
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(params.cfg, agentId),
  }));
  const reports = scopes.map(({ agentId, workspaceDir }) => {
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      config: params.cfg,
      agentId,
    });
    return { agentId, report, unavailable: collectUnavailableAgentSkills(report) };
  });
  const fleetUnavailable = collectFleetUnavailableSkills(
    reports.map(({ report, unavailable: unavailableForAgent }) => ({
      skills: report.skills,
      unavailable: unavailableForAgent,
    })),
  );
  const globallyUnavailableKeys = new Set(fleetUnavailable.map((skill) => skill.skillKey));
  for (const { agentId, report, unavailable: unavailableForAgent } of reports) {
    const prefix = agentIds.length > 1 ? `Agent "${agentId}":\n` : "";
    const githubHint = describeGhConfigDirHint(report.skills);
    if (githubHint.length > 0) {
      note(`${prefix}${githubHint.join("\n")}`, "GitHub CLI");
    }
    if (unavailableForAgent.length > 0) {
      const includesGlobalCandidate = unavailableForAgent.some((skill) =>
        globallyUnavailableKeys.has(skill.skillKey),
      );
      note(
        `${prefix}${formatUnavailableSkillDoctorLines(unavailableForAgent, includesGlobalCandidate).join("\n")}`,
        "Skills",
      );
    }
  }
  if (fleetUnavailable.length === 0) {
    return params.cfg;
  }

  const shouldDisable = await params.prompter.confirmAutoFix({
    message:
      agentIds.length === 1
        ? `Disable ${fleetUnavailable.length} unavailable skill${fleetUnavailable.length === 1 ? "" : "s"} in config?`
        : `Disable ${fleetUnavailable.length} skill${fleetUnavailable.length === 1 ? "" : "s"} unavailable to every configured agent?`,
    initialValue: false,
  });
  if (!shouldDisable) {
    return params.cfg;
  }

  const next = disableUnavailableSkillsInConfig(params.cfg, fleetUnavailable);
  note(fleetUnavailable.map((skill) => `- Disabled ${skill.name}`).join("\n"), "Doctor changes");
  return next;
}
