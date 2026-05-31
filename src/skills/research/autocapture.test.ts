import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import {
  applySkillProposal,
  inspectSkillProposal,
  listSkillProposals,
} from "../workshop/service.js";
import { runSkillResearchAutoCapture } from "./autocapture.js";

const tempDirs = createTrackedTempDirs();
let envSnapshot: ReturnType<typeof captureEnv>;

beforeEach(async () => {
  envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  process.env.OPENCLAW_STATE_DIR = await tempDirs.make("openclaw-skill-workshop-state-");
});

afterEach(async () => {
  envSnapshot.restore();
  await tempDirs.cleanup();
});

async function makeWorkspace(): Promise<string> {
  return await tempDirs.make("openclaw-skill-workshop-");
}

describe("skill research auto-capture", () => {
  it("queues a pending proposal from durable user correction", async () => {
    const workspaceDir = await makeWorkspace();

    await runSkillResearchAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content:
              "From now on, when working on GitHub PRs, always check CI before final response.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main" },
      config: {
        skills: {
          workshop: {
            autonomous: {
              enabled: true,
            },
          },
        },
      },
    });

    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]).toMatchObject({
      kind: "create",
      status: "pending",
      skillKey: "github-pr-workflow",
      scanState: "clean",
    });
    const proposal = await inspectSkillProposal(proposals.proposals[0].id, { workspaceDir });
    expect(proposal?.content).toContain("status: proposal");
    expect(proposal?.content).toContain("always check CI before final response");
  });

  it("stays inert when auto-capture is disabled", async () => {
    const workspaceDir = await makeWorkspace();

    await runSkillResearchAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content: "Remember to always verify generated screenshots before replying.",
          },
        ],
      },
      ctx: { workspaceDir },
      config: {
        skills: {
          workshop: {
            autonomous: {
              enabled: false,
            },
          },
        },
      },
    });

    expect((await listSkillProposals({ workspaceDir })).proposals).toHaveLength(0);
  });

  it("preserves existing skill content when auto-capturing an update", async () => {
    const workspaceDir = await makeWorkspace();
    const skillFile = path.join(workspaceDir, "skills", "github-pr-workflow", "SKILL.md");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(
      skillFile,
      [
        "---",
        'name: "github-pr-workflow"',
        'description: "Existing GitHub PR workflow."',
        "---",
        "",
        "# GitHub PR Workflow",
        "",
        "- Preserve this original review checklist.",
        "",
      ].join("\n"),
      "utf8",
    );

    await runSkillResearchAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content:
              "From now on, when working on GitHub PRs, always check CI before final response.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main" },
      config: {
        skills: {
          workshop: {
            autonomous: {
              enabled: true,
            },
          },
        },
      },
    });

    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]).toMatchObject({
      kind: "update",
      status: "pending",
      skillKey: "github-pr-workflow",
    });

    await applySkillProposal({ workspaceDir, proposalId: proposals.proposals[0].id });
    const updatedSkill = await fs.readFile(skillFile, "utf8");
    expect(updatedSkill).toContain("Preserve this original review checklist.");
    expect(updatedSkill).toContain("always check CI before final response");
  });
});
