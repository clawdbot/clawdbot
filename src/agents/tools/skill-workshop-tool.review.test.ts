// skill_workshop review-mode tests cover the proposal-only reviewer surface:
// mutation budgets, read receipts, and patch/update drafting for live skills.
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consumeRunSkillUsage, recordRunSkillUsage } from "../../skills/runtime/run-usage.js";
import { writeWorkspaceSkills } from "../../skills/test-support/e2e-test-helpers.js";
import { readSkillProposalRecord } from "../../skills/workshop/store.js";
import type { SkillWorkshopProposalMutationBudget } from "../../skills/workshop/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-workshop-review-state-",
  });
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

async function seedLiveSkill(
  workspaceDir: string,
  name: string,
  description: string,
  content: string,
): Promise<void> {
  const fullTool = createSkillWorkshopTool({
    workspaceDir,
    config: { skills: { workshop: { approvalPolicy: "auto" } } },
  });
  const created = await fullTool.execute("seed-create", {
    action: "create",
    name,
    description,
    proposal_content: content,
  });
  await fullTool.execute("seed-apply", {
    action: "apply",
    proposal_id: (created.details as { id: string }).id,
    reason: "seed live skill",
  });
}

describe("skill_workshop review mode", () => {
  it("keeps an autonomous foreground repair pending for a user-authored skill", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-user-repair-");
    const runId = "user-authored-repair";
    const skillName = "operator-runbook";
    const skillFile = path.join(workspaceDir, "skills", skillName, "SKILL.md");
    await writeWorkspaceSkills(workspaceDir, [
      {
        name: skillName,
        description: "Run an operator-owned procedure",
        body: "# Operator Runbook\n\nCheck the old prerequisite.\n",
      },
    ]);
    const tool = createSkillWorkshopTool({
      workspaceDir,
      config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
      env: testState.env,
      agentId: "main",
      origin: { agentId: "main", runId },
    });
    await tool.execute("user-repair-read", { action: "read", skill_name: skillName });
    recordRunSkillUsage({
      runId,
      name: skillName,
      source: "workspace",
      activation: "read",
      skillFile,
    });

    const result = await tool.execute("user-repair-patch", {
      action: "patch",
      skill_name: skillName,
      old_string: "Check the old prerequisite.",
      new_string: "Check the current prerequisite.",
    });

    expect(result.details).toMatchObject({ status: "pending", kind: "update" });
    expect((result.content[0] as { text: string }).text).toContain("user-authored; proposal");
    const record = await readSkillProposalRecord((result.details as { id: string }).id, {
      env: testState.env,
    });
    expect(record?.statusReason).toBe("user-authored skill; awaiting operator review");
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("old prerequisite");
    consumeRunSkillUsage(runId);
  });

  it("restricts internal review runs to one pending proposal mutation", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-review-");
    const proposalMutationBudget: SkillWorkshopProposalMutationBudget = { remaining: 1 };
    const tool = createSkillWorkshopTool({
      workspaceDir,
      config: { skills: { workshop: { approvalPolicy: "auto" } } },
      proposalOnly: true,
      proposalMutationBudget,
    });
    const foregroundTool = createSkillWorkshopTool({
      workspaceDir,
      config: { skills: { workshop: { approvalPolicy: "auto" } } },
    });

    expect(
      (tool.parameters as { properties: { action: { enum: string[] } } }).properties.action.enum,
    ).toEqual(
      (foregroundTool.parameters as { properties: { action: { enum: string[] } } }).properties
        .action.enum,
    );
    expect(tool.description).toBe(foregroundTool.description);
    await expect(
      tool.execute("call-apply", { action: "apply", proposal_id: "proposal-1" }),
    ).rejects.toThrow("review allows only");
    await expect(
      tool.execute("call-evaluate", { action: "evaluate", proposal_id: "proposal-1" }),
    ).rejects.toThrow("review allows only");
    await expect(
      tool.execute("call-update", {
        action: "update",
        skill_name: "existing-skill",
        proposal_content: "# Replacement\n",
      }),
    ).rejects.toThrow("review allows only");

    await tool.execute("call-create", {
      action: "create",
      name: "Review Learning",
      description: "Reuse a recovered workflow",
      proposal_content: "# Review Learning\n\nFollow the recovered workflow.\n",
    });
    expect(proposalMutationBudget.completed).toBe(1);
    const retryTool = createSkillWorkshopTool({
      workspaceDir,
      proposalOnly: true,
      proposalMutationBudget,
    });
    await expect(
      retryTool.execute("call-create-2", {
        action: "create",
        name: "Second Learning",
        description: "Should stay blocked",
        proposal_content: "# Second Learning\n",
      }),
    ).rejects.toThrow("reached its proposal mutation limit");
  });

  it("lets internal review runs draft update proposals for existing skills", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-review-update-");
    await seedLiveSkill(
      workspaceDir,
      "weather-planner",
      "Plan around the weather forecast",
      "# Weather Planner\n\nCheck weather before outdoor recommendations.\n",
    );

    const proposalMutationBudget: SkillWorkshopProposalMutationBudget = { remaining: 1 };
    const reviewTool = createSkillWorkshopTool({
      workspaceDir,
      proposalOnly: true,
      updateProposals: true,
      proposalMutationBudget,
    });
    await expect(
      reviewTool.execute("update-without-read", {
        action: "update",
        skill_name: "weather-planner",
        proposal_content: "# Weather Planner\n\nCheck alerts and timing.\n",
      }),
    ).rejects.toThrow("read the live skill first");
    await reviewTool.execute("review-read", { action: "read", skill_name: "weather-planner" });
    const update = await reviewTool.execute("review-update", {
      action: "update",
      skill_name: "weather-planner",
      proposal_content:
        "# Weather Planner\n\nCheck weather before outdoor recommendations.\nCheck alerts and timing.\n",
    });

    expect(update.details).toMatchObject({
      status: "pending",
      kind: "update",
      skillKey: "weather-planner",
    });
    expect(proposalMutationBudget.remaining).toBe(0);
  });

  it("keeps a user-authored update pending when detached review tries to apply it", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-review-apply-");
    const skillName = "operator-runbook";
    const skillFile = path.join(workspaceDir, "skills", skillName, "SKILL.md");
    await writeWorkspaceSkills(workspaceDir, [
      {
        name: skillName,
        description: "Run an operator-owned procedure",
        body: "# Operator Runbook\n\nCheck the old prerequisite.\n",
      },
    ]);
    const reviewTool = createSkillWorkshopTool({
      workspaceDir,
      env: testState.env,
      proposalOnly: true,
      updateProposals: true,
      proposalMutationBudget: { remaining: 1 },
    });
    await reviewTool.execute("review-read", { action: "read", skill_name: skillName });
    const patched = await reviewTool.execute("review-patch", {
      action: "patch",
      skill_name: skillName,
      old_string: "Check the old prerequisite.",
      new_string: "Check the current prerequisite.",
    });
    const proposalId = (patched.details as { id: string }).id;

    await expect(
      reviewTool.execute("review-apply", { action: "apply", proposal_id: proposalId }),
    ).rejects.toThrow("review allows only");

    const record = await readSkillProposalRecord(proposalId, { env: testState.env });
    expect(record?.status).toBe("pending");
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("old prerequisite");
  });

  it("composes patch proposals by replacing the quoted span of the live body", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-review-extend-");
    await seedLiveSkill(
      workspaceDir,
      "weather-planner",
      "Plan around the weather forecast",
      "# Weather Planner\n\nCheck weather before outdoor recommendations.\n",
    );

    const proposalMutationBudget: SkillWorkshopProposalMutationBudget = { remaining: 1 };
    const reviewTool = createSkillWorkshopTool({
      workspaceDir,
      proposalOnly: true,
      updateProposals: true,
      proposalMutationBudget,
    });
    expect(
      (reviewTool.parameters as { properties: { action: { enum: string[] } } }).properties.action
        .enum,
    ).toEqual(
      (
        createSkillWorkshopTool({ workspaceDir }).parameters as {
          properties: { action: { enum: string[] } };
        }
      ).properties.action.enum,
    );

    await expect(
      reviewTool.execute("patch-without-read", {
        action: "patch",
        skill_name: "weather-planner",
        old_string: "Check weather before outdoor recommendations.",
        new_string: "Replacement.",
      }),
    ).rejects.toThrow("read the live skill first");

    await reviewTool.execute("review-read", { action: "read", skill_name: "weather-planner" });
    await expect(
      reviewTool.execute("patch-no-match", {
        action: "patch",
        skill_name: "weather-planner",
        old_string: "Text that is not in the skill.",
        new_string: "Replacement.",
      }),
    ).rejects.toThrow("not found in the live skill body");

    const extended = await reviewTool.execute("review-patch", {
      action: "patch",
      skill_name: "weather-planner",
      old_string: "Check weather before outdoor recommendations.",
      new_string:
        "Check weather before outdoor recommendations.\nCheck alerts and timing before recommending.",
    });

    expect(extended.details).toMatchObject({
      status: "pending",
      kind: "update",
      skillKey: "weather-planner",
    });
    expect((extended.details as { description?: string }).description ?? "").not.toContain(
      "Replacement",
    );
    const inspected = await createSkillWorkshopTool({ workspaceDir }).execute("inspect-extend", {
      action: "inspect",
      proposal_id: (extended.details as { id: string }).id,
    });
    const content = (inspected as { details: { content?: string } }).details.content ?? "";
    const inspectText = (inspected.content[0] as { text: string }).text;
    const proposalBody = content || inspectText;
    expect(proposalBody).toContain("Check weather before outdoor recommendations.");
    expect(proposalBody).toContain("Check alerts and timing before recommending.");
  });

  it("refuses a patch when the skill changed after the read", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-stale-patch-");
    await seedLiveSkill(
      workspaceDir,
      "weather-planner",
      "Plan around the weather forecast",
      "# Weather Planner\n\nCheck weather before outdoor recommendations.\n",
    );

    const proposalMutationBudget: SkillWorkshopProposalMutationBudget = { remaining: 1 };
    const reviewTool = createSkillWorkshopTool({
      workspaceDir,
      proposalOnly: true,
      updateProposals: true,
      proposalMutationBudget,
    });
    await reviewTool.execute("review-read", { action: "read", skill_name: "weather-planner" });
    const liveSkillFile = path.join(workspaceDir, "skills", "weather-planner", "SKILL.md");
    await fs.writeFile(
      liveSkillFile,
      (await fs.readFile(liveSkillFile, "utf8")).replace(
        "Check weather before outdoor recommendations.",
        "Operator-edited steps after the read.",
      ),
    );
    await expect(
      reviewTool.execute("stale-patch", {
        action: "patch",
        skill_name: "weather-planner",
        old_string: "Check weather before outdoor recommendations.",
        new_string: "Replacement.",
      }),
    ).rejects.toThrow("changed since it was read");
    expect(proposalMutationBudget.remaining).toBe(1);
  });

  it("refunds a stale update race so the reviewer can re-read and retry", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-stale-update-race-");
    await seedLiveSkill(
      workspaceDir,
      "weather-planner",
      "Plan around the weather forecast",
      "# Weather Planner\n\nCheck weather before outdoor recommendations.\n",
    );

    const liveSkillFile = path.join(workspaceDir, "skills", "weather-planner", "SKILL.md");
    const operatorEditedSkill = (await fs.readFile(liveSkillFile, "utf8")).replace(
      "Check weather before outdoor recommendations.",
      "Operator-edited steps during proposal creation.",
    );
    let remaining = 1;
    let mutateOnReserve = false;
    const proposalMutationBudget: SkillWorkshopProposalMutationBudget = {
      get remaining() {
        return remaining;
      },
      set remaining(value) {
        remaining = value;
        if (mutateOnReserve && value === 0) {
          mutateOnReserve = false;
          writeFileSync(liveSkillFile, operatorEditedSkill, "utf8");
        }
      },
    };
    const reviewTool = createSkillWorkshopTool({
      workspaceDir,
      proposalOnly: true,
      updateProposals: true,
      proposalMutationBudget,
    });
    await reviewTool.execute("review-read", { action: "read", skill_name: "weather-planner" });

    mutateOnReserve = true;
    await expect(
      reviewTool.execute("stale-update-race", {
        action: "update",
        skill_name: "weather-planner",
        proposal_content: "# Weather Planner\n\nCheck alerts and timing.\n",
      }),
    ).rejects.toThrow("Skill changed since the reviewer's read");
    expect(proposalMutationBudget.remaining).toBe(1);

    await reviewTool.execute("review-read-again", {
      action: "read",
      skill_name: "weather-planner",
    });
    const update = await reviewTool.execute("review-update-retry", {
      action: "update",
      skill_name: "weather-planner",
      proposal_content:
        "# Weather Planner\n\nOperator-edited steps during proposal creation.\nCheck alerts and timing.\n",
    });
    expect(update.details).toMatchObject({ status: "pending", kind: "update" });
    expect(proposalMutationBudget.remaining).toBe(0);
  });

  it("rejects oversized growth but permits shrink in review mode", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-review-read-cap-");
    await seedLiveSkill(
      workspaceDir,
      "big-skill",
      "A very large operator skill",
      `# Big Skill\n\n${"A detailed operational line.\n".repeat(1200)}`,
    );

    const reviewTool = createSkillWorkshopTool({
      workspaceDir,
      proposalOnly: true,
      updateProposals: true,
      autonomousCapture: true,
      proposalMutationBudget: { remaining: 1 },
      modelContextWindowTokens: 200_000,
    });
    await expect(
      reviewTool.execute("oversized-create", {
        action: "create",
        name: "too-large",
        description: "An oversized new skill",
        proposal_content: `# Too Large\n\n${"Unbounded detail.\n".repeat(800)}`,
      }),
    ).rejects.toThrow(/autonomous limit is 10,000.*Prune stale steps/);
    const read = await reviewTool.execute("review-read", {
      action: "read",
      skill_name: "big-skill",
    });
    const text = (read.content[0] as { text: string }).text;
    expect(read.details).toMatchObject({ skillKey: "big-skill", contentIncluded: true });
    expect(text).toContain("A detailed operational line.");

    await expect(
      reviewTool.execute("oversized-growth", {
        action: "update",
        skill_name: "big-skill",
        proposal_content: `# Big Skill\n\n${"Longer procedure.\n".repeat(2100)}`,
      }),
    ).rejects.toThrow(/autonomous limit is 10,000.*bundled file/);

    const update = await reviewTool.execute("oversized-update", {
      action: "update",
      skill_name: "big-skill",
      proposal_content: `# Big Skill\n\n${"Shorter procedure.\n".repeat(700)}`,
    });
    expect(update.details).toMatchObject({ kind: "update", status: "pending" });
  });

  it("does not refund the review mutation budget after a failed mutation", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-review-failure-");
    const proposalMutationBudget: SkillWorkshopProposalMutationBudget = { remaining: 1 };
    const tool = createSkillWorkshopTool({
      workspaceDir,
      proposalOnly: true,
      proposalMutationBudget,
    });

    await expect(
      tool.execute("call-revise-missing", {
        action: "revise",
        proposal_id: "missing-proposal",
        proposal_content: "# Missing Skill\n",
      }),
    ).rejects.toThrow();
    await expect(
      tool.execute("call-create-after-failure", {
        action: "create",
        name: "Second Mutation",
        description: "Must remain blocked after a failed mutation",
        proposal_content: "# Second Mutation\n",
      }),
    ).rejects.toThrow("reached its proposal mutation limit");
    expect(proposalMutationBudget.completed).toBeUndefined();
    expect(proposalMutationBudget.failedMutations).toBe(1);
  });
});
