import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createConfiguredSkillWorkshopTool } from "./skill-workshop-tool-factory.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-workshop-revision-constraint-",
  });
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

describe("skill_workshop operator revision constraint", () => {
  it("hard-binds the turn to the reviewed proposal revision", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-bound-revision-");
    const foregroundTool = createSkillWorkshopTool({
      workspaceDir,
      env: testState.env,
      agentId: "main",
    });
    const created = await foregroundTool.execute("create", {
      action: "create",
      name: "Bound Revision",
      description: "Exercise operator revision binding",
      proposal_content: "# Bound Revision\n\nFirst draft.\n",
    });
    const reviewed = created.details as { id: string; revisionHash: string };
    const revisionTool = createConfiguredSkillWorkshopTool({
      workspaceDir: await tempDirs.make("openclaw-skill-workshop-chat-agent-"),
      agentId: "writer",
      run: {
        env: testState.env,
        proposalRevision: {
          agentId: "main",
          workspaceDir,
          proposalId: reviewed.id,
          expectedRevisionHash: reviewed.revisionHash,
        },
      },
    });

    expect(
      (revisionTool.parameters as { properties: { action: { enum: string[] } } }).properties.action
        .enum,
    ).toEqual(["inspect", "revise"]);
    await expect(revisionTool.execute("inspect", { action: "inspect" })).resolves.toMatchObject({
      details: { id: reviewed.id, revisionHash: reviewed.revisionHash },
    });
    await expect(
      revisionTool.execute("wrong-action", { action: "reject", proposal_id: reviewed.id }),
    ).rejects.toThrow("can only inspect or revise");
    await expect(
      revisionTool.execute("wrong-proposal", {
        action: "revise",
        proposal_id: "another-proposal",
        proposal_content: "# Wrong\n",
      }),
    ).rejects.toThrow("proposal_id conflicts");
    await expect(
      revisionTool.execute("wrong-hash", {
        action: "revise",
        expected_revision_hash: "another-hash",
        proposal_content: "# Wrong\n",
      }),
    ).rejects.toThrow("expected_revision_hash conflicts");

    const h2 = await foregroundTool.execute("concurrent-h2", {
      action: "revise",
      proposal_id: reviewed.id,
      expected_revision_hash: reviewed.revisionHash,
      proposal_content: "# Bound Revision\n\nSecond draft.\n",
    });
    const h2Details = h2.details as { revisionHash: string };
    const h3 = await foregroundTool.execute("concurrent-h3", {
      action: "revise",
      proposal_id: reviewed.id,
      expected_revision_hash: h2Details.revisionHash,
      proposal_content: "# Bound Revision\n\nThird draft.\n",
    });
    const current = h3.details as { revisionHash: string };
    await expect(
      revisionTool.execute("stale-revision", {
        action: "revise",
        proposal_content: "# Bound Revision\n\nStale operator draft.\n",
      }),
    ).rejects.toThrow("proposal revision changed");
    await expect(
      foregroundTool.execute("inspect-current", { action: "inspect", proposal_id: reviewed.id }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Third draft") }],
      details: {
        id: reviewed.id,
        status: "pending",
        revisionHash: current.revisionHash,
        inspect: { contentIncluded: true },
      },
    });
  });

  it("refuses an empty bound revision hash", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-empty-bound-revision-");
    const tool = createSkillWorkshopTool({
      workspaceDir,
      env: testState.env,
      proposalRevision: {
        agentId: "main",
        workspaceDir,
        proposalId: "proposal-1",
        expectedRevisionHash: "",
      },
    });

    await expect(
      tool.execute("missing-bound-hash", {
        action: "revise",
        proposal_content: "# Missing hash\n",
      }),
    ).rejects.toThrow("operator-reviewed expected_revision_hash required");
  });
});
