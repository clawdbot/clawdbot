import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";

const hookMocks = vi.hoisted(() => ({
  proposalChanged: vi.fn(),
  skillChanged: vi.fn(),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (hookName: string) =>
      ["skill_changed", "skill_proposal_changed", "skill_proposal_evaluate"].includes(hookName),
    runSkillProposalEvaluate: async () => [],
    runSkillProposalChanged: hookMocks.proposalChanged,
    runSkillChanged: hookMocks.skillChanged,
  }),
}));

import {
  applySkillProposal,
  inspectSkillProposal,
  listSkillProposalEvents,
  proposeCreateSkill,
  proposeUpdateSkill,
  rejectSkillProposal,
} from "./service.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-lifecycle-hooks-state-",
  });
  hookMocks.proposalChanged.mockReset();
  hookMocks.skillChanged.mockReset();
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

describe("Skill Workshop lifecycle hooks", () => {
  it("emits a committed live-skill artifact after apply", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-lifecycle-hooks-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      agentId: "main",
      name: "Lifecycle Hook",
      description: "Exercise committed skill notifications",
      content: "# Lifecycle Hook\n",
    });
    hookMocks.proposalChanged.mockClear();

    await applySkillProposal({
      workspaceDir,
      agentId: "main",
      proposalId: proposal.record.id,
      expectedRevisionHash: proposal.revisionHash,
    });

    expect(hookMocks.skillChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "created",
        source: "workshop",
        proposal: {
          id: proposal.record.id,
          revision: "v1",
          revisionSha256: proposal.revisionHash,
        },
        after: expect.objectContaining({
          skillKey: "lifecycle-hook",
          source: "workshop",
          revision: expect.objectContaining({
            sourceVersion: "v1",
            contentSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            treeSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          }),
        }),
      }),
      { workspaceDir },
    );
    await expect(
      fs.readFile(path.join(workspaceDir, "skills", "lifecycle-hook", "SKILL.md"), "utf8"),
    ).resolves.toContain("# Lifecycle Hook");
  });

  it("records and dispatches stale transitions detected during apply", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-lifecycle-stale-");
    const skillDir = path.join(workspaceDir, "skills", "existing");
    await writeSkill({
      dir: skillDir,
      name: "existing",
      description: "Existing skill",
      body: "# Existing\n\nBefore.\n",
    });
    const proposal = await proposeUpdateSkill({
      workspaceDir,
      agentId: "main",
      skillName: "existing",
      content: "# Existing\n\nAfter.\n",
    });
    await fs.appendFile(path.join(skillDir, "SKILL.md"), "\nChanged elsewhere.\n");
    hookMocks.proposalChanged.mockClear();

    await expect(
      applySkillProposal({
        workspaceDir,
        agentId: "main",
        proposalId: proposal.record.id,
        expectedRevisionHash: proposal.revisionHash,
        correlationId: "optimizer-run-stale",
      }),
    ).rejects.toThrow("proposal marked stale");

    expect(
      listSkillProposalEvents({ workspaceDir, proposalId: proposal.record.id }).events.map(
        (event) => event.type,
      ),
    ).toEqual(["created", "evaluation_completed", "stale"]);
    expect(hookMocks.proposalChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "stale",
        correlationId: "optimizer-run-stale",
        proposal: expect.objectContaining({ status: "stale" }),
      }),
      { workspaceDir, agentId: "main" },
    );
  });

  it("marks a create proposal stale when its target appears before evaluation", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-lifecycle-create-stale-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      agentId: "main",
      name: "Create Stale",
      description: "Record create conflicts before evaluator dispatch",
      content: "# Create Stale\n",
    });
    await writeSkill({
      dir: proposal.record.target.skillDir,
      name: "create-stale",
      description: "Created elsewhere",
      body: "# Created Elsewhere\n",
    });
    hookMocks.proposalChanged.mockClear();

    await expect(
      applySkillProposal({
        workspaceDir,
        agentId: "main",
        proposalId: proposal.record.id,
        expectedRevisionHash: proposal.revisionHash,
        correlationId: "optimizer-run-create-stale",
      }),
    ).rejects.toThrow("proposal marked stale");

    expect(
      listSkillProposalEvents({ workspaceDir, proposalId: proposal.record.id }).events.map(
        (event) => event.type,
      ),
    ).toEqual(["created", "stale"]);
    await expect(inspectSkillProposal(proposal.record.id, { workspaceDir })).resolves.toMatchObject(
      {
        record: { status: "stale" },
      },
    );
    expect(hookMocks.proposalChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "stale",
        correlationId: "optimizer-run-create-stale",
        proposal: expect.objectContaining({ status: "stale" }),
      }),
      { workspaceDir, agentId: "main" },
    );
  });

  it("releases the target lease before dispatching a reconciliation hook", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-lifecycle-reconcile-lock-");
    const first = await proposeCreateSkill({
      workspaceDir,
      agentId: "main",
      name: "Reconcile Lock",
      description: "First proposal sharing the target.",
      content: "# Reconcile Lock\n",
    });
    const second = await proposeCreateSkill({
      workspaceDir,
      agentId: "main",
      name: "Reconcile Lock",
      description: "Second proposal sharing the target.",
      content: "# Reconcile Lock\n",
    });
    await writeSkill({
      dir: first.record.target.skillDir,
      name: "reconcile-lock",
      description: "Created elsewhere",
      body: "# Created Elsewhere\n",
    });
    const hookEntered = createDeferred();
    const releaseHook = createDeferred();
    hookMocks.proposalChanged.mockImplementation(async (event) => {
      if (event.action === "stale" && event.proposal.id === first.record.id) {
        hookEntered.resolve();
        await releaseHook.promise;
      }
    });

    const inspection = inspectSkillProposal(first.record.id, { workspaceDir });
    await hookEntered.promise;
    try {
      const rejected = await rejectSkillProposal({
        workspaceDir,
        agentId: "main",
        proposalId: second.record.id,
      });
      expect(rejected.status).toBe("rejected");
    } finally {
      releaseHook.resolve();
    }
    await expect(inspection).resolves.toMatchObject({ record: { status: "stale" } });
    expect(
      listSkillProposalEvents({ workspaceDir, proposalId: first.record.id }).events.map(
        (event) => event.type,
      ),
    ).toEqual(["created", "stale"]);
  });

  it("rejects apply when an untouched target asset changes after evaluation", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-lifecycle-evaluation-race-");
    const skillDir = path.join(workspaceDir, "skills", "existing");
    await writeSkill({
      dir: skillDir,
      name: "existing",
      description: "Existing skill",
      body: "# Existing\n\nBefore.\n",
    });
    const untouchedAsset = path.join(skillDir, "references", "untouched.txt");
    await fs.mkdir(path.dirname(untouchedAsset), { recursive: true });
    await fs.writeFile(untouchedAsset, "before\n");
    const proposal = await proposeUpdateSkill({
      workspaceDir,
      agentId: "main",
      skillName: "existing",
      content: "# Existing\n\nAfter.\n",
    });
    hookMocks.proposalChanged.mockImplementation(async (event) => {
      if (event.action === "evaluation_completed") {
        await fs.writeFile(untouchedAsset, "changed after evaluation\n");
      }
    });

    await expect(
      applySkillProposal({
        workspaceDir,
        agentId: "main",
        proposalId: proposal.record.id,
        expectedRevisionHash: proposal.revisionHash,
      }),
    ).rejects.toThrow("Skill target changed after evaluation");
    await expect(fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).resolves.toContain(
      "Before.",
    );
    await expect(fs.readFile(untouchedAsset, "utf8")).resolves.toBe("changed after evaluation\n");
  });

  it("records and dispatches scanner quarantine transitions", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-lifecycle-quarantine-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      agentId: "main",
      name: "Unsafe Lifecycle",
      description: "Unsafe proposal",
      content: "# Unsafe\n\n```ts\nimport { exec } from 'child_process';\nexec('whoami');\n```\n",
    });
    hookMocks.proposalChanged.mockClear();

    await expect(
      applySkillProposal({
        workspaceDir,
        agentId: "main",
        proposalId: proposal.record.id,
        expectedRevisionHash: proposal.revisionHash,
      }),
    ).rejects.toThrow("Proposal scan failed");

    await expect(inspectSkillProposal(proposal.record.id, { workspaceDir })).resolves.toMatchObject(
      {
        record: { status: "quarantined" },
      },
    );
    expect(
      listSkillProposalEvents({ workspaceDir, proposalId: proposal.record.id }).events.map(
        (event) => event.type,
      ),
    ).toEqual(["created", "evaluation_completed", "quarantined"]);
    expect(hookMocks.proposalChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "quarantined",
        proposal: expect.objectContaining({ status: "quarantined" }),
      }),
      { workspaceDir, agentId: "main" },
    );
  });
});
