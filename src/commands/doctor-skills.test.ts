import { describe, expect, it } from "vitest";
import type { SkillStatusEntry, SkillStatusReport } from "../agents/skills-status.js";
import type { GhConfigDiscoveryInput } from "../agents/skills/gh-config-discovery.js";
import { createEmptyInstallChecks } from "../cli/requirements-test-fixtures.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectUnavailableAgentSkills,
  describeGhConfigDirHintFromDiscovery,
  disableUnavailableSkillsInConfig,
  formatUnavailableSkillDoctorLines,
} from "./doctor-skills.js";

function createSkill(overrides: Partial<SkillStatusEntry>): SkillStatusEntry {
  return {
    name: "demo",
    description: "Demo",
    source: "test",
    bundled: false,
    filePath: "/tmp/demo/SKILL.md",
    baseDir: "/tmp/demo",
    skillKey: overrides.name ?? "demo",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: false,
    eligible: true,
    modelVisible: true,
    userInvocable: true,
    commandVisible: true,
    ...createEmptyInstallChecks(),
    ...overrides,
  };
}

function createReport(skills: SkillStatusEntry[]): SkillStatusReport {
  return {
    workspaceDir: "/tmp/ws",
    managedSkillsDir: "/tmp/managed",
    agentId: "main",
    skills,
  };
}

describe("doctor skills", () => {
  it("collects only unavailable skills that this agent is allowed to use", () => {
    const unavailable = createSkill({
      name: "missing-bin",
      eligible: false,
      modelVisible: false,
      commandVisible: false,
      missing: { bins: ["tool"], anyBins: [], env: [], config: [], os: [] },
    });
    const report = createReport([
      createSkill({ name: "ready" }),
      unavailable,
      createSkill({ name: "disabled", eligible: false, disabled: true }),
      createSkill({ name: "agent-filtered", eligible: true, blockedByAgentFilter: true }),
      createSkill({ name: "bundled-blocked", eligible: false, blockedByAllowlist: true }),
    ]);

    expect(collectUnavailableAgentSkills(report)).toEqual([unavailable]);
  });

  it("formats actionable missing requirement lines without secret values", () => {
    const lines = formatUnavailableSkillDoctorLines([
      createSkill({
        name: "places",
        eligible: false,
        missing: {
          bins: ["goplaces"],
          anyBins: [],
          env: ["GOOGLE_MAPS_API_KEY"],
          config: [],
          os: [],
        },
        install: [
          {
            id: "brew",
            kind: "brew",
            label: "Install goplaces (brew)",
            bins: ["goplaces"],
          },
        ],
      }),
    ]);

    expect(lines.join("\n")).toContain("places: bins: goplaces; env: GOOGLE_MAPS_API_KEY");
    expect(lines.join("\n")).toContain("install option: Install goplaces (brew)");
    expect(lines.join("\n")).toContain("openclaw doctor --fix");
  });

  it("surfaces a GH_CONFIG_DIR hint when the github skill is eligible but auth lives at a different HOME", () => {
    const githubSkill = createSkill({
      name: "github",
      skillKey: "github",
      eligible: true,
      missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
    });
    const discovery: GhConfigDiscoveryInput = {
      platform: "linux",
      env: { HOME: "/root/.openclaw/agents/main/agent/codex-home/home" },
      fileExists: (p) => p === "/root/.config/gh/hosts.yml",
    };

    const lines = describeGhConfigDirHintFromDiscovery([githubSkill], discovery);

    expect(lines.some((line) => line.includes("/root/.config/gh"))).toBe(true);
    expect(lines.join("\n")).toContain("GH_CONFIG_DIR=/root/.config/gh");
  });

  it("does not surface the GH_CONFIG_DIR hint when the github skill is missing the gh binary", () => {
    const githubSkill = createSkill({
      name: "github",
      skillKey: "github",
      eligible: false,
      missing: { bins: ["gh"], anyBins: [], env: [], config: [], os: [] },
    });
    const discovery: GhConfigDiscoveryInput = {
      platform: "linux",
      env: { HOME: "/agent/home" },
      fileExists: (p) => p === "/root/.config/gh/hosts.yml",
    };

    expect(describeGhConfigDirHintFromDiscovery([githubSkill], discovery)).toEqual([]);
  });

  it("does not surface the GH_CONFIG_DIR hint when the github skill is disabled", () => {
    const githubSkill = createSkill({
      name: "github",
      skillKey: "github",
      eligible: false,
      disabled: true,
      missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
    });
    const discovery: GhConfigDiscoveryInput = {
      platform: "linux",
      env: { HOME: "/agent/home" },
      fileExists: (p) => p === "/root/.config/gh/hosts.yml",
    };

    expect(describeGhConfigDirHintFromDiscovery([githubSkill], discovery)).toEqual([]);
  });

  it("does not surface the GH_CONFIG_DIR hint when the github skill is filtered out for the agent", () => {
    const githubSkill = createSkill({
      name: "github",
      skillKey: "github",
      eligible: true,
      blockedByAgentFilter: true,
      missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
    });
    const discovery: GhConfigDiscoveryInput = {
      platform: "linux",
      env: { HOME: "/agent/home" },
      fileExists: (p) => p === "/root/.config/gh/hosts.yml",
    };

    expect(describeGhConfigDirHintFromDiscovery([githubSkill], discovery)).toEqual([]);
  });

  it("does not surface the GH_CONFIG_DIR hint when GH_CONFIG_DIR is already set", () => {
    const githubSkill = createSkill({
      name: "github",
      skillKey: "github",
      eligible: true,
      missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
    });
    const discovery: GhConfigDiscoveryInput = {
      platform: "linux",
      env: { HOME: "/agent/home", GH_CONFIG_DIR: "/etc/openclaw/gh" },
      fileExists: () => true,
    };

    expect(describeGhConfigDirHintFromDiscovery([githubSkill], discovery)).toEqual([]);
  });

  it("does not surface the GH_CONFIG_DIR hint when the github skill is not present in the report", () => {
    const discovery: GhConfigDiscoveryInput = {
      platform: "linux",
      env: { HOME: "/agent/home" },
      fileExists: (p) => p === "/root/.config/gh/hosts.yml",
    };

    expect(describeGhConfigDirHintFromDiscovery([], discovery)).toEqual([]);
  });

  it("disables unavailable skills through skills.entries without dropping existing config", () => {
    const config: OpenClawConfig = {
      skills: {
        entries: {
          gog: { env: { EXISTING: "1" } },
          other: { enabled: true },
        },
      },
    };

    const next = disableUnavailableSkillsInConfig(config, [
      createSkill({ name: "gog", skillKey: "gog", eligible: false }),
      createSkill({ name: "wacli", skillKey: "wacli", eligible: false }),
    ]);

    expect(next.skills?.entries?.gog).toEqual({ env: { EXISTING: "1" }, enabled: false });
    expect(next.skills?.entries?.wacli).toEqual({ enabled: false });
    expect(next.skills?.entries?.other).toEqual({ enabled: true });
    expect(config.skills?.entries?.gog).toEqual({ env: { EXISTING: "1" } });
  });
});
