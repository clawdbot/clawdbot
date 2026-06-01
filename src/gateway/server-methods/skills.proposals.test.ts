import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { callGatewayHandler } from "./skills.test-helpers.js";

const tempDirs = createTrackedTempDirs();
let envSnapshot: ReturnType<typeof captureEnv>;
let stateDir = "";

const mocks = vi.hoisted(() => ({
  workspaceDir: "",
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  writeConfigFile: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => mocks.workspaceDir,
}));

vi.mock("../../skills/lifecycle/clawhub.js", () => ({
  installSkillFromClawHub: vi.fn(),
  readLocalSkillCardContentSync: vi.fn(),
  searchSkillsFromClawHub: vi.fn(),
  updateSkillsFromClawHub: vi.fn(),
}));

vi.mock("../../skills/lifecycle/install.js", () => ({
  installSkill: vi.fn(),
}));

vi.mock("../../skills/lifecycle/upload-install.js", () => ({
  installUploadedSkillArchive: vi.fn(),
}));

vi.mock("../../infra/clawhub.js", () => ({
  fetchClawHubSkillDetail: vi.fn(),
}));

vi.mock("../../skills/security/clawhub-verdicts.js", () => ({
  collectClawHubVerdictTargets: vi.fn(() => []),
  fetchOpenClawSkillSecurityVerdicts: vi.fn(),
}));

const { skillsHandlers } = await import("./skills.js");

function callHandler(method: string, params: Record<string, unknown>) {
  return callGatewayHandler(skillsHandlers, method, params);
}

describe("skills proposal gateway handlers", () => {
  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    mocks.workspaceDir = await tempDirs.make("openclaw-skills-proposals-gateway-");
    stateDir = await tempDirs.make("openclaw-skills-proposals-gateway-state-");
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    envSnapshot.restore();
    await tempDirs.cleanup();
  });

  it("creates, lists, inspects, and applies a proposal", async () => {
    const create = await callHandler("skills.proposals.create", {
      name: "Weather Planner",
      description: "Plan around current weather",
      content: "# Weather Planner\n\nCheck weather before outdoor recommendations.\n",
      supportFiles: [
        {
          path: "references/weather.md",
          content: "Use current weather before recommendations.\n",
        },
      ],
    });
    expect(create.ok).toBe(true);
    const created = create.response as {
      record: { id: string; supportFiles?: Array<{ path: string }> };
    };
    expect(created.record.id).toMatch(/^weather-planner-/);
    expect(created.record.supportFiles?.[0]?.path).toBe("references/weather.md");

    const list = await callHandler("skills.proposals.list", {});
    expect(list.ok).toBe(true);
    expect((list.response as { proposals: Array<{ id: string }> }).proposals[0]?.id).toBe(
      created.record.id,
    );

    const inspect = await callHandler("skills.proposals.inspect", {
      proposalId: created.record.id,
    });
    expect(inspect.ok).toBe(true);
    expect((inspect.response as { content: string }).content).toContain("status: proposal");
    expect(
      (
        inspect.response as {
          supportFiles?: Array<{ path: string; content: string }>;
        }
      ).supportFiles,
    ).toEqual([
      {
        path: "references/weather.md",
        content: "Use current weather before recommendations.\n",
      },
    ]);

    const revise = await callHandler("skills.proposals.revise", {
      proposalId: created.record.id,
      description: "Plan with current weather",
      content: "# Weather Planner\n\nUse current weather and alerts.\n",
    });
    expect(revise.ok).toBe(true);
    expect(
      (revise.response as { record: { id: string; proposedVersion: string } }).record,
    ).toMatchObject({
      id: created.record.id,
      proposedVersion: "v2",
    });

    const apply = await callHandler("skills.proposals.apply", {
      proposalId: created.record.id,
    });
    expect(apply.ok).toBe(true);
    await expect(
      fs.readFile(path.join(mocks.workspaceDir, "skills", "weather-planner", "SKILL.md"), "utf8"),
    ).resolves.toContain("Use current weather and alerts.");
    await expect(
      fs.readFile(
        path.join(mocks.workspaceDir, "skills", "weather-planner", "references", "weather.md"),
        "utf8",
      ),
    ).resolves.toContain("Use current weather");
  });

  it("scopes list and inspect to the resolved agent workspace", async () => {
    const firstWorkspaceDir = mocks.workspaceDir;
    const first = await callHandler("skills.proposals.create", {
      name: "First Gateway Skill",
      description: "First workspace proposal",
      content: "# First\n",
    });
    expect(first.ok).toBe(true);
    const firstCreated = first.response as { record: { id: string } };

    const secondWorkspaceDir = await tempDirs.make("openclaw-skills-proposals-gateway-second-");
    mocks.workspaceDir = secondWorkspaceDir;
    const second = await callHandler("skills.proposals.create", {
      name: "Second Gateway Skill",
      description: "Second workspace proposal",
      content: "# Second\n",
    });
    expect(second.ok).toBe(true);
    const secondCreated = second.response as { record: { id: string } };

    const secondList = await callHandler("skills.proposals.list", {});
    expect(secondList.ok).toBe(true);
    expect((secondList.response as { proposals: Array<{ id: string }> }).proposals).toEqual([
      expect.objectContaining({ id: secondCreated.record.id }),
    ]);

    const hiddenInspect = await callHandler("skills.proposals.inspect", {
      proposalId: firstCreated.record.id,
    });
    expect(hiddenInspect.ok).toBe(false);
    expect((hiddenInspect.error as { message?: string }).message).toContain(
      `Skill proposal not found: ${firstCreated.record.id}`,
    );

    mocks.workspaceDir = firstWorkspaceDir;
    const firstList = await callHandler("skills.proposals.list", {});
    expect(firstList.ok).toBe(true);
    expect((firstList.response as { proposals: Array<{ id: string }> }).proposals).toEqual([
      expect.objectContaining({ id: firstCreated.record.id }),
    ]);
  });

  it("rejects invalid params before touching workshop state", async () => {
    const result = await callHandler("skills.proposals.create", {
      name: "Missing Content",
      description: "No content",
    });
    expect(result.ok).toBe(false);
    expect((result.error as { code?: string }).code).toBe("INVALID_REQUEST");
    await expect(fs.access(path.join(stateDir, "skill-workshop"))).rejects.toThrow();
  });
});
