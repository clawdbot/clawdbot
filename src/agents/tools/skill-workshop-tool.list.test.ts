import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeWorkspaceSkills } from "../../skills/test-support/e2e-test-helpers.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

const commitLockState = vi.hoisted(() => ({ active: false, calls: 0 }));

vi.mock("../../skills/workshop/target-lock.js", () => ({
  withSkillCollectionLock: async (_workspaceDir: string, fn: () => Promise<unknown>) => await fn(),
  withSkillProposalTargetLock: async (_record: unknown, fn: () => Promise<unknown>) => await fn(),
  withSkillProposalCommitLock: async (
    _workspaceDir: string,
    _record: unknown,
    fn: () => Promise<unknown>,
  ) => {
    if (commitLockState.active) {
      throw new Error("skill proposal reconciliations overlapped");
    }
    commitLockState.active = true;
    commitLockState.calls += 1;
    await Promise.resolve();
    try {
      return await fn();
    } finally {
      commitLockState.active = false;
    }
  },
}));

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  commitLockState.active = false;
  commitLockState.calls = 0;
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-workshop-list-state-",
  });
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

describe("skill_workshop list", () => {
  it("lists a pending proposal whose draft is missing", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-missing-draft-");
    const tool = createSkillWorkshopTool({
      workspaceDir,
      config: {},
      agentId: "main",
      env: testState.env,
    });
    const created = await tool.execute("call-create", {
      action: "create",
      name: "Missing Draft",
      description: "Proposal with a missing draft artifact.",
      proposal_content: "# Missing Draft\n",
    });
    const proposalId = (created.details as { id: string }).id;
    await fs.rm(
      path.join(testState.stateDir, "skill-workshop", "proposals", proposalId, "PROPOSAL.md"),
    );

    const listed = await tool.execute("call-list", { action: "list" });
    const listText = (listed.content[0] as { text: string }).text;
    expect(listText).toContain(proposalId);
    expect(listText).toContain("draft missing");
    expect(listed.details).toMatchObject({
      proposals: [
        { id: proposalId, status: "pending", kind: "create", degradedState: "draft-missing" },
      ],
    });
    await expect(
      tool.execute("call-inspect", { action: "inspect", proposal_id: proposalId }),
    ).rejects.toThrow(`Skill proposal draft is missing: ${proposalId}. Reject and re-propose it.`);
    await expect(
      tool.execute("call-apply", { action: "apply", proposal_id: proposalId }),
    ).rejects.toThrow(`Skill proposal draft is missing: ${proposalId}. Reject and re-propose it.`);
    await expect(
      tool.execute("call-reject", { action: "reject", proposal_id: proposalId }),
    ).resolves.toMatchObject({ details: { id: proposalId, status: "rejected" } });
  });

  it.each([0, 1.5, "1.5", "25items", "many"])(
    "rejects invalid list limit %s before touching proposal state",
    async (limit) => {
      const workspaceDir = await tempDirs.make("openclaw-skill-workshop-list-");
      const tool = createSkillWorkshopTool({
        workspaceDir,
        config: {},
        agentId: "main",
        env: testState.env,
      });

      await expect(tool.execute("call-list-limit", { action: "list", limit })).rejects.toThrow(
        "limit must be a positive integer",
      );
      await expect(fs.access(path.join(testState.stateDir, "skill-workshop"))).rejects.toThrow();
    },
  );

  it("reconciles a full pending page while preserving list limits through 50", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-list-");
    const tool = createSkillWorkshopTool({
      workspaceDir,
      config: { skills: { workshop: { maxPending: 200 } } },
      agentId: "main",
      env: testState.env,
    });

    for (let index = 0; index < 51; index += 1) {
      await tool.execute(`call-create-${index}`, {
        action: "create",
        name: `Limit Proposal ${index}`,
        description: `Proposal ${index}`,
        proposal_content: `# Limit Proposal ${index}\n`,
      });
    }
    await writeWorkspaceSkills(
      workspaceDir,
      Array.from({ length: 51 }, (_, index) => ({
        name: `limit-proposal-${index}`,
        description: `Materialized proposal ${index}`,
      })),
    );

    for (const [limit, expectedCount] of [
      [49, 49],
      [50, 50],
      [51, 50],
    ] as const) {
      const result = await tool.execute(`call-list-${limit}`, { action: "list", limit });
      const proposals = (result.details as { proposals: Array<{ status: string }> }).proposals;
      expect(proposals).toHaveLength(expectedCount);
      expect(proposals.every((proposal) => proposal.status === "stale")).toBe(true);
    }

    await expect(
      tool.execute("call-list-last", {
        action: "list",
        query: "Limit Proposal 50",
        limit: 1,
      }),
    ).resolves.toMatchObject({
      details: { proposals: [expect.objectContaining({ status: "stale" })] },
    });
    expect(commitLockState.calls).toBe(51);
  });
});
