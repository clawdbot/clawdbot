// Doctor skills tests cover skill install checks, status summaries, and repair guidance.
import { describe, expect, it, vi } from "vitest";
import { createEmptyInstallChecks } from "../cli/requirements-test-fixtures.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SkillStatusEntry, SkillStatusReport } from "../skills/discovery/status.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  collectUnavailableAgentSkills,
  disableUnavailableSkillsInConfig,
} from "./doctor-skills-core.js";
import { maybeRepairSkillReadiness } from "./doctor-skills.js";

const mocks = vi.hoisted(() => ({
  buildWorkspaceSkillStatus: vi.fn(),
  detectGhConfigDirMismatch: vi.fn(),
  note: vi.fn(),
}));

vi.mock("../skills/discovery/status.js", async (importActual) => ({
  ...(await importActual<typeof import("../skills/discovery/status.js")>()),
  buildWorkspaceSkillStatus: mocks.buildWorkspaceSkillStatus,
}));
vi.mock("../skills/lifecycle/gh-config-discovery.js", async (importActual) => ({
  ...(await importActual<typeof import("../skills/lifecycle/gh-config-discovery.js")>()),
  detectGhConfigDirMismatch: mocks.detectGhConfigDirMismatch,
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));

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
    platformIncompatible: false,
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

function createPrompter(): DoctorPrompter {
  return {
    confirm: vi.fn(async () => false),
    confirmAutoFix: vi.fn(async () => false),
    confirmAggressiveAutoFix: vi.fn(async () => false),
    confirmRuntimeRepair: vi.fn(async () => false),
    select: vi.fn(async (_params, fallback) => fallback),
    shouldRepair: false,
    shouldForce: false,
    repairMode: {
      shouldRepair: false,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: true,
      updateInProgress: false,
    },
  };
}

async function runSkillDoctor(skills: SkillStatusEntry[]) {
  mocks.note.mockClear();
  mocks.buildWorkspaceSkillStatus.mockReturnValue(createReport(skills));
  await maybeRepairSkillReadiness({
    cfg: {},
    prompter: createPrompter(),
  });
  return mocks.note.mock.calls;
}

describe("doctor skills", () => {
  it("collects only unavailable skills that this agent is allowed to use", () => {
    const unavailable = createSkill({
      name: "missing-bin",
      eligible: false,
      platformIncompatible: false,
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

  it("formats unavailable skill names compactly and alphabetically", async () => {
    const calls = await runSkillDoctor([
      createSkill({
        name: "places",
        eligible: false,
        platformIncompatible: false,
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
      createSkill({
        name: "calendar",
        eligible: false,
        platformIncompatible: false,
      }),
    ]);

    const body = calls.find((call) => call[1] === "Skills")?.[0];
    expect(typeof body === "string" ? body.split("\n") : []).toEqual([
      "2 allowed skills are not usable in this environment (missing binaries, env vars, or config).",
      "- calendar, places",
      "Disable unused skills: openclaw doctor --fix",
      "Inspect details: openclaw skills check --agent <id> or openclaw skills info <name> --agent <id>",
    ]);
  });

  it("uses singular grammar for one unavailable skill", async () => {
    const calls = await runSkillDoctor([createSkill({ name: "places", eligible: false })]);
    const body = calls.find((call) => call[1] === "Skills")?.[0];
    expect(typeof body === "string" ? body.split("\n")[0] : undefined).toBe(
      "1 allowed skill is not usable in this environment (missing binaries, env vars, or config).",
    );
  });

  it("surfaces a GH_CONFIG_DIR hint through the doctor path", async () => {
    const githubSkill = createSkill({
      name: "github",
      skillKey: "github",
      eligible: true,
      platformIncompatible: false,
      missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
    });
    mocks.detectGhConfigDirMismatch.mockReturnValue({
      kind: "mismatch",
      effectiveConfigDir: "/agent/home/.config/gh",
      alternateConfigDir: "/root/.config/gh",
      alternateHostsFile: "/root/.config/gh/hosts.yml",
      alternateHomeHint: "/root",
      suggestedEnvValue: "/root/.config/gh",
    });
    const calls = await runSkillDoctor([githubSkill]);
    const output = String(calls.find((call) => call[1] === "GitHub CLI")?.[0] ?? "");

    expect(output).toContain("/root/.config/gh");
    expect(output).toContain("GH_CONFIG_DIR=/root/.config/gh");
  });

  it("does not surface the GH_CONFIG_DIR hint for an ineligible skill", async () => {
    const githubSkill = createSkill({
      name: "github",
      skillKey: "github",
      eligible: false,
      platformIncompatible: false,
      missing: { bins: ["gh"], anyBins: [], env: [], config: [], os: [] },
    });
    const calls = await runSkillDoctor([githubSkill]);
    expect(calls.some((call) => call[1] === "GitHub CLI")).toBe(false);
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
