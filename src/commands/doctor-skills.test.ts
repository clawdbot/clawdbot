import { describe, expect, it } from "vitest";
import type { SkillStatusEntry, SkillStatusReport } from "../agents/skills-status.js";
import { createEmptyInstallChecks } from "../cli/requirements-test-fixtures.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectUnavailableAgentSkills,
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
