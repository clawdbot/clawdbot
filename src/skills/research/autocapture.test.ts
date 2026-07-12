// Research autocapture tests cover capture policy, persistence, and config gating.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionEntry, upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  consumeSessionSkillSuggestion,
  recordSessionSkillCaptureSignals,
} from "../../config/sessions/skill-suggestions.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import {
  applySkillProposal,
  inspectSkillProposal,
  listSkillProposals,
  proposeCreateSkill,
  rejectSkillProposal,
} from "../workshop/service.js";
import * as workshopService from "../workshop/service.js";
import { runSkillResearchAutoCapture } from "./autocapture.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
const SESSION_KEY = "agent:main:main";

async function seedSession(sessionKey = SESSION_KEY): Promise<void> {
  await upsertSessionEntry(
    { agentId: "main", sessionKey },
    { sessionId: `session-${sessionKey}`, updatedAt: 1 },
  );
}

function readSession(sessionKey = SESSION_KEY) {
  return loadSessionEntry({ agentId: "main", sessionKey, readConsistency: "latest" });
}

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-workshop-state-",
  });
  await seedSession();
});

afterEach(async () => {
  await testState.cleanup();
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
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
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
    const proposal = await inspectSkillProposal(
      expectDefined(proposals.proposals[0], "proposals.proposals[0] test invariant").id,
      { workspaceDir },
    );
    expect(proposal?.content).toContain("status: proposal");
    expect(proposal?.content).toContain("always check CI before final response");
  });

  it("records one suggestion for the most recent group when autonomy is disabled", async () => {
    const workspaceDir = await makeWorkspace();
    const event = {
      success: true,
      messages: [
        {
          role: "user",
          content:
            "From now on, when working on GitHub PRs, always check CI before final response.",
        },
        {
          role: "user",
          content: "Remember to always verify generated screenshots before replying.",
        },
      ],
    };
    const ctx = { workspaceDir, agentId: "main", sessionKey: SESSION_KEY };
    const config = {
      skills: {
        workshop: {
          autonomous: {
            enabled: false,
          },
        },
      },
    };

    await runSkillResearchAutoCapture({
      event,
      ctx,
      config,
    });

    expect((await listSkillProposals({ workspaceDir })).proposals).toHaveLength(0);
    expect(readSession()?.pendingSkillSuggestion).toMatchObject({
      skillName: "screenshot-asset-workflow",
    });
    expect(readSession()?.skillCaptureSignalHashes?.length).toBeGreaterThan(0);

    await consumeSessionSkillSuggestion({ agentId: "main", sessionKey: SESSION_KEY });
    await runSkillResearchAutoCapture({ event, ctx, config });
    expect(readSession()?.pendingSkillSuggestion).toBeUndefined();
  });

  it.each([
    {
      name: "subagent helper session",
      ctx: { sessionKey: "agent:main:subagent:worker" },
    },
    {
      name: "cron automation session",
      ctx: { trigger: "cron", sessionKey: "agent:main:cron:daily:run:run-1" },
    },
    {
      name: "heartbeat automation session",
      ctx: { trigger: "heartbeat", sessionKey: "agent:main:main" },
    },
    {
      name: "hook-scoped session",
      ctx: { sessionKey: "hook:gmail:message-1" },
    },
    {
      name: "Active Memory trigger",
      ctx: { trigger: "memory", sessionKey: "explicit:user-session:active-memory:abc123" },
    },
    {
      name: "Active Memory helper session with main suffix",
      ctx: { trigger: "manual", sessionKey: "agent:main:main:active-memory:abc123" },
    },
    {
      name: "Active Memory helper session without main suffix",
      ctx: { trigger: "manual", sessionKey: "agent:main:active-memory:abc123" },
    },
    {
      name: "Active Memory recall helper session",
      ctx: { trigger: "manual", sessionKey: "active-memory-recall-87504" },
    },
  ])("skips $name before queuing proposals", async ({ ctx }) => {
    const workspaceDir = await makeWorkspace();
    await seedSession(ctx.sessionKey);

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
      ctx: { workspaceDir, agentId: "main", ...ctx },
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
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
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

    await applySkillProposal({
      workspaceDir,
      proposalId: expectDefined(proposals.proposals[0], "proposals.proposals[0] test invariant").id,
    });
    const updatedSkill = await fs.readFile(skillFile, "utf8");
    expect(updatedSkill).toContain("Preserve this original review checklist.");
    expect(updatedSkill).toContain("always check CI before final response");
  });

  it("queues a proposal from a reactive correction, not just prospective phrasing", async () => {
    const workspaceDir = await makeWorkspace();

    await runSkillResearchAutoCapture({
      event: {
        success: true,
        messages: [
          {
            role: "user",
            content:
              "You're still using the transcripts as tone references — they should not be included as voice material at all.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
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
      skillKey: "learned-workflows",
    });
    const proposal = await inspectSkillProposal(
      expectDefined(proposals.proposals[0], "proposals.proposals[0] test invariant").id,
      { workspaceDir },
    );
    expect(proposal?.content).toContain("should not be included as voice material");
  });

  it("routes a correction to the existing workspace skill it is about", async () => {
    const workspaceDir = await makeWorkspace();
    const skillFile = path.join(workspaceDir, "skills", "signal-scout", "SKILL.md");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(
      skillFile,
      [
        "---",
        'name: "signal-scout"',
        'description: "Mine the market for signals and validate them before drafting."',
        "---",
        "",
        "# Signal Scout",
        "",
        "- Capture first, score later.",
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
              "I thought we were working on listening — capture real market signals with quoted evidence before scoring anything.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
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
      skillKey: "signal-scout",
    });

    await applySkillProposal({
      workspaceDir,
      proposalId: expectDefined(proposals.proposals[0], "proposals.proposals[0] test invariant").id,
    });
    const updatedSkill = await fs.readFile(skillFile, "utf8");
    expect(updatedSkill).toContain("Capture first, score later.");
    expect(updatedSkill).toContain("capture real market signals with quoted evidence");
  });

  it("routes a correction to a writable project agent skill under .agents/skills", async () => {
    const workspaceDir = await makeWorkspace();
    const skillFile = path.join(workspaceDir, ".agents", "skills", "signal-scout", "SKILL.md");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(
      skillFile,
      [
        "---",
        'name: "signal-scout"',
        'description: "Mine the market for signals and validate them before drafting."',
        "---",
        "",
        "# Signal Scout",
        "",
        "- Capture first, score later.",
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
              "I thought we were working on listening — capture real market signals with quoted evidence before scoring anything.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
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
      skillKey: "signal-scout",
    });

    await applySkillProposal({
      workspaceDir,
      proposalId: expectDefined(proposals.proposals[0], "proposals.proposals[0] test invariant").id,
    });
    const updatedSkill = await fs.readFile(skillFile, "utf8");
    expect(updatedSkill).toContain("Capture first, score later.");
    expect(updatedSkill).toContain("capture real market signals with quoted evidence");
  });

  it("captures corrections from failed runs", async () => {
    const workspaceDir = await makeWorkspace();

    await runSkillResearchAutoCapture({
      event: {
        success: false,
        messages: [
          {
            role: "user",
            content:
              "From now on, when working on GitHub PRs, always check CI before final response.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
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
    });
  });

  it("queues one proposal per distinct topic when a session has several corrections", async () => {
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
          {
            role: "user",
            content: "Remember to always optimize screenshot assets before attaching them.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
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
    const skillKeys = proposals.proposals.map((entry) => entry.skillKey).toSorted();
    expect(skillKeys).toEqual(["github-pr-workflow", "screenshot-asset-workflow"]);
  });

  it("does not replay a topic omitted by the per-turn proposal cap", async () => {
    const workspaceDir = await makeWorkspace();
    const event = {
      success: true,
      messages: [
        {
          role: "user",
          content: "From now on, always check GitHub pull request CI before final response.",
        },
        {
          role: "user",
          content: "Remember to always optimize screenshot assets before attaching them.",
        },
        {
          role: "user",
          content: "Going forward, always write a QA scenario before testing this workflow.",
        },
        {
          role: "user",
          content: "Next time, always verify animated GIF output before replying.",
        },
      ],
    };
    const ctx = { workspaceDir, agentId: "main", sessionKey: SESSION_KEY };
    const config = { skills: { workshop: { autonomous: { enabled: true } } } };

    await runSkillResearchAutoCapture({ event, ctx, config });
    await runSkillResearchAutoCapture({ event, ctx, config });

    const skillKeys = (await listSkillProposals({ workspaceDir })).proposals
      .map((entry) => entry.skillKey)
      .toSorted();
    expect(skillKeys).toEqual([
      "animated-gif-workflow",
      "qa-scenario-workflow",
      "screenshot-asset-workflow",
    ]);
  });

  it("suppresses autocapture when the same run used skill_workshop to create a proposal", async () => {
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
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-learn",
                name: "skill_workshop",
                arguments: { action: "create", name: "github-pr-workflow" },
              },
            ],
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
      config: { skills: { workshop: { autonomous: { enabled: true } } } },
    });

    expect((await listSkillProposals({ workspaceDir })).proposals).toHaveLength(0);
    expect(readSession()?.skillCaptureSignalHashes).toHaveLength(1);
  });

  it("captures when the same-run skill_workshop mutation explicitly failed", async () => {
    const workspaceDir = await makeWorkspace();

    await runSkillResearchAutoCapture({
      event: {
        success: false,
        messages: [
          {
            role: "user",
            content:
              "From now on, when working on GitHub PRs, always check CI before final response.",
          },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-learn-failed",
                name: "skill_workshop",
                arguments: { action: "create", name: "github-pr-workflow" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call-learn-failed",
            toolName: "skill_workshop",
            content: [{ type: "text", text: "proposal rejected" }],
            isError: true,
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
      config: { skills: { workshop: { autonomous: { enabled: true } } } },
    });

    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(1);
    expect(
      expectDefined(proposals.proposals[0], "proposals.proposals[0] test invariant").skillKey,
    ).toBe("github-pr-workflow");
  });

  it("does not let a historical skill_workshop call suppress a later correction", async () => {
    const workspaceDir = await makeWorkspace();
    const learnedTurn = [
      {
        role: "user",
        content: "From now on, always check CI before final response on GitHub pull requests.",
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "skill_workshop",
            arguments: { action: "create", name: "github-pr-workflow" },
          },
        ],
      },
    ];
    const ctx = { workspaceDir, agentId: "main", sessionKey: SESSION_KEY };
    const config = { skills: { workshop: { autonomous: { enabled: true } } } };

    await runSkillResearchAutoCapture({
      event: { success: true, messages: learnedTurn },
      ctx,
      config,
    });
    await runSkillResearchAutoCapture({
      event: {
        success: true,
        messages: [
          ...learnedTurn,
          {
            role: "user",
            content: "Remember to always optimize screenshot assets before attaching them.",
          },
        ],
      },
      ctx,
      config,
    });

    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(1);
    expect(
      expectDefined(proposals.proposals[0], "proposals.proposals[0] test invariant").skillKey,
    ).toBe("screenshot-asset-workflow");
  });

  it("revises the pending autocapture proposal with a second correction", async () => {
    const workspaceDir = await makeWorkspace();
    const first = {
      role: "user",
      content: "From now on, for GitHub pull requests, always check CI before final response.",
    };
    const second = {
      role: "user",
      content:
        "You're still ignoring GitHub merge checks — always inspect the exact head before landing.",
    };
    const config = { skills: { workshop: { autonomous: { enabled: true } } } };

    await runSkillResearchAutoCapture({
      event: { success: true, messages: [first] },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
      config,
    });
    await runSkillResearchAutoCapture({
      event: { success: true, messages: [first, second] },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
      config,
    });

    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(1);
    const proposal = await inspectSkillProposal(
      expectDefined(proposals.proposals[0], "proposals.proposals[0] test invariant").id,
      { workspaceDir },
    );
    expect(proposal?.record.proposedVersion).toBe("v2");
    expect(proposal?.content).toContain("inspect the exact head before landing");
    expect(proposal?.content.match(/check CI before final response/g)).toHaveLength(1);
  });

  it("serializes concurrent revisions for one session", async () => {
    const workspaceDir = await makeWorkspace();
    const first = {
      role: "user",
      content: "From now on, for GitHub pull requests, always check CI before final response.",
    };
    const exactHead = {
      role: "user",
      content: "You're still ignoring GitHub merge checks — always inspect the exact head.",
    };
    const comments = {
      role: "user",
      content: "Remember to always read GitHub review comments before landing a pull request.",
    };
    const ctx = { workspaceDir, agentId: "main", sessionKey: SESSION_KEY };
    const config = { skills: { workshop: { autonomous: { enabled: true } } } };

    await runSkillResearchAutoCapture({
      event: { success: true, messages: [first] },
      ctx,
      config,
    });
    await Promise.all([
      runSkillResearchAutoCapture({
        event: { success: true, messages: [first, exactHead] },
        ctx,
        config,
      }),
      runSkillResearchAutoCapture({
        event: { success: true, messages: [first, comments] },
        ctx,
        config,
      }),
    ]);

    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(1);
    const proposal = await inspectSkillProposal(
      expectDefined(proposals.proposals[0], "proposals.proposals[0] test invariant").id,
      { workspaceDir },
    );
    expect(proposal?.record.proposedVersion).toBe("v3");
    expect(proposal?.content).toContain("inspect the exact head");
    expect(proposal?.content).toContain("read GitHub review comments");
  });

  it.each(["applied", "rejected"] as const)(
    "does not replay a %s autocapture proposal from the same transcript",
    async (status) => {
      const workspaceDir = await makeWorkspace();
      const event = {
        success: true,
        messages: [
          {
            role: "user",
            content:
              "From now on, when working on GitHub PRs, always check CI before final response.",
          },
        ],
      };
      const ctx = { workspaceDir, agentId: "main", sessionKey: SESSION_KEY };
      const config = { skills: { workshop: { autonomous: { enabled: true } } } };

      await runSkillResearchAutoCapture({ event, ctx, config });
      const proposalId = expectDefined(
        (await listSkillProposals({ workspaceDir })).proposals[0],
        "(await listSkillProposals({ workspaceDir })).proposals[0] test invariant",
      ).id;
      if (status === "applied") {
        await applySkillProposal({ workspaceDir, proposalId });
      } else {
        await rejectSkillProposal({ workspaceDir, proposalId });
      }
      await runSkillResearchAutoCapture({ event, ctx, config });

      const proposals = await listSkillProposals({ workspaceDir });
      expect(proposals.proposals).toHaveLength(1);
      expect(
        expectDefined(proposals.proposals[0], "proposals.proposals[0] test invariant").status,
      ).toBe(status);
    },
  );

  it("captures only new fingerprints after a failed turn", async () => {
    const workspaceDir = await makeWorkspace();
    const previous = {
      role: "user",
      content: "From now on, for GitHub pull requests, always check CI before final response.",
    };
    const newCorrection = {
      role: "user",
      content: "Remember to always optimize screenshot assets before attaching them.",
    };
    const ctx = { workspaceDir, agentId: "main", sessionKey: SESSION_KEY };
    const config = { skills: { workshop: { autonomous: { enabled: true } } } };

    await runSkillResearchAutoCapture({
      event: { success: true, messages: [previous] },
      ctx,
      config,
    });
    await runSkillResearchAutoCapture({
      event: { success: false, messages: [previous, newCorrection] },
      ctx,
      config,
    });

    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(2);
    const screenshotEntry = proposals.proposals.find(
      (entry) => entry.skillKey === "screenshot-asset-workflow",
    );
    expect(screenshotEntry).toBeDefined();
    const screenshot = await inspectSkillProposal(screenshotEntry?.id ?? "", { workspaceDir });
    expect(screenshot?.content).toContain("optimize screenshot assets");
    expect(screenshot?.content).not.toContain("check CI before final response");
  });

  it("performs no workspace skill discovery when the turn has no durable signal", async () => {
    const workspaceDir = await makeWorkspace();
    const discovery = vi.spyOn(workshopService, "listWritableWorkspaceSkillSummaries");

    await runSkillResearchAutoCapture({
      event: {
        success: true,
        messages: [{ role: "user", content: "Please review this pull request." }],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
    });

    expect(discovery).not.toHaveBeenCalled();
    discovery.mockRestore();
  });

  it("suggests saving a correction into an existing routed skill", async () => {
    const workspaceDir = await makeWorkspace();
    const skillFile = path.join(workspaceDir, "skills", "signal-scout", "SKILL.md");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(
      skillFile,
      [
        "---",
        'name: "signal-scout"',
        'description: "Mine market signals before drafting."',
        "---",
        "",
        "# Signal Scout",
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
              "I thought we agreed to capture quoted market signals before drafting anything.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
    });

    expect((await listSkillProposals({ workspaceDir })).proposals).toHaveLength(0);
    expect(readSession()?.pendingSkillSuggestion).toMatchObject({ skillName: "signal-scout" });
  });

  it("suggests an inferred topic when its exact skill already exists", async () => {
    const workspaceDir = await makeWorkspace();
    const skillFile = path.join(workspaceDir, "skills", "github-pr-workflow", "SKILL.md");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(
      skillFile,
      [
        "---",
        'name: "github-pr-workflow"',
        'description: "Release checklist."',
        "---",
        "",
        "# GitHub PR Workflow",
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
              "From now on, for pull requests, always inspect the exact head before landing.",
          },
        ],
      },
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
    });

    expect(readSession()?.pendingSkillSuggestion).toMatchObject({
      skillName: "github-pr-workflow",
    });
  });

  it("never revises a manual pending proposal for the same skill", async () => {
    const workspaceDir = await makeWorkspace();
    const manual = await proposeCreateSkill({
      workspaceDir,
      name: "github-pr-workflow",
      description: "Manual GitHub workflow proposal.",
      content: "# GitHub PR Workflow\n\n- Manual draft.\n",
      createdBy: "cli",
    });

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
      ctx: { workspaceDir, agentId: "main", sessionKey: SESSION_KEY },
      config: { skills: { workshop: { autonomous: { enabled: true } } } },
    });

    const proposals = await listSkillProposals({ workspaceDir });
    expect(proposals.proposals).toHaveLength(1);
    const unchanged = await inspectSkillProposal(manual.record.id, { workspaceDir });
    expect(unchanged?.record.createdBy).toBe("cli");
    expect(unchanged?.record.proposedVersion).toBe("v1");
  });

  it("bounds captured signal fingerprints to the newest 32", async () => {
    await recordSessionSkillCaptureSignals({
      agentId: "main",
      sessionKey: SESSION_KEY,
      signalHashes: Array.from({ length: 40 }, (_, index) => `hash-${index}`),
    });

    expect(readSession()?.skillCaptureSignalHashes).toEqual(
      Array.from({ length: 32 }, (_, index) => `hash-${index + 8}`),
    );
  });

  it("does not re-suggest a dismissed fingerprint", async () => {
    const workspaceDir = await makeWorkspace();
    const event = {
      success: true,
      messages: [
        {
          role: "user",
          content: "Remember to always verify generated screenshots before replying.",
        },
      ],
    };
    const ctx = { workspaceDir, agentId: "main", sessionKey: SESSION_KEY };

    await runSkillResearchAutoCapture({ event, ctx });
    expect(
      (
        await consumeSessionSkillSuggestion({
          agentId: "main",
          sessionKey: SESSION_KEY,
        })
      )?.suggestion,
    ).toBeDefined();
    await runSkillResearchAutoCapture({ event, ctx });

    expect(readSession()?.pendingSkillSuggestion).toBeUndefined();
    expect((await listSkillProposals({ workspaceDir })).proposals).toHaveLength(0);
  });
});
