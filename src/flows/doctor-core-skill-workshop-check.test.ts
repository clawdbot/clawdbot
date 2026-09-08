import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCoreHealthChecks } from "./doctor-core-checks.js";
import { runDoctorLintChecks } from "./doctor-lint-flow.js";
import type { HealthCheck } from "./health-checks.js";

const runtime = { log() {}, error() {}, exit() {} };

function getSkillWorkshopCheck(): HealthCheck {
  const check = createCoreHealthChecks().find(
    (candidate) => candidate.id === "core/doctor/skill-workshop-tool-policy",
  );
  if (!check || !("detect" in check)) {
    throw new Error("missing Skill Workshop health check");
  }
  return check;
}

describe("core/doctor/skill-workshop-tool-policy", () => {
  it("warns when autonomous capture is enabled but policy hides its tool", async () => {
    const findings = await getSkillWorkshopCheck().detect({
      mode: "doctor",
      runtime,
      cfg: {
        skills: { workshop: { autonomous: { mode: "propose" } } },
        tools: { profile: "messaging" },
      },
    });

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: 'tools.profile: "messaging" does not include "skill_workshop".',
        path: "tools.profile",
        fixHint: 'Add tools.alsoAllow: ["skill_workshop"].',
      }),
    ]);
  });

  it("checks every explicit-roster agent without turning selection into a health error", async () => {
    const cfg: OpenClawConfig = {
      skills: { workshop: { autonomous: { mode: "propose" } } },
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          main: { tools: { profile: "coding" } },
          helper: { tools: { profile: "messaging" } },
          third: { tools: { profile: "coding" } },
        },
      },
    };

    const result = await runDoctorLintChecks(
      { mode: "lint", runtime, cfg },
      { checks: [getSkillWorkshopCheck()] },
    );

    expect(result.findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        target: "helper",
        path: "agents.entries.helper.tools.profile",
      }),
    ]);
    expect(result.findings).not.toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("health check threw") }),
    );
  });

  it.each([
    {
      label: "sole-agent roster",
      cfg: {
        agents: { entries: { solo: { tools: { profile: "messaging" } } } },
      } satisfies OpenClawConfig,
      target: "solo",
    },
    {
      label: "legacy-default roster",
      cfg: {
        agents: {
          list: [
            { id: "owner", default: true, tools: { profile: "messaging" } },
            { id: "helper", tools: { profile: "coding" } },
          ],
        },
      } satisfies OpenClawConfig,
      target: "owner",
    },
  ])("preserves normal diagnostics for a $label", async ({ cfg, target }) => {
    const findings = await getSkillWorkshopCheck().detect({
      mode: "doctor",
      runtime,
      cfg: {
        ...cfg,
        skills: { workshop: { autonomous: { mode: "propose" } } },
      },
    });

    expect(findings).toEqual([expect.objectContaining({ severity: "warning", target })]);
  });

  it("does not warn when autonomous capture is disabled", async () => {
    await expect(
      getSkillWorkshopCheck().detect({
        mode: "doctor",
        runtime,
        cfg: {
          skills: { workshop: { autonomous: { mode: "off" } } },
          tools: { profile: "messaging" },
        },
      }),
    ).resolves.toEqual([]);
  });
});
