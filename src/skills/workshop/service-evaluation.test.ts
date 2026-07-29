import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginHookSkillProposalEvaluateEvent } from "../../plugins/hook-types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";

const hookMocks = vi.hoisted(() => ({
  evaluate: vi.fn(),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (hookName: string) => hookName === "skill_proposal_evaluate",
    runSkillProposalEvaluate: hookMocks.evaluate,
  }),
}));

import {
  evaluateSkillProposal,
  inspectSkillProposal,
  listSkillProposalEvents,
  proposeCreateSkill,
  proposeUpdateSkill,
  reviseSkillProposal,
} from "./service.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-evaluation-state-",
  });
  hookMocks.evaluate.mockReset();
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

describe("Skill Workshop proposal evaluation", () => {
  it("persists attributed results and exposes durable lifecycle events", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      agentId: "main",
      name: "Evaluation Demo",
      description: "Exercise third-party proposal evaluation",
      content: "# Evaluation Demo\n",
      supportFiles: [{ path: "references/input.txt", content: "candidate\n" }],
    });
    hookMocks.evaluate.mockResolvedValue([
      {
        evaluatorId: "nvidia.skill-eval",
        pluginId: "nvidia-tools",
        pluginVersion: "1.2.3",
        status: "completed",
        result: {
          evaluatorVersion: "rules-7",
          mode: "baseline-comparison",
          decision: "revise",
          decisionReason: "Coverage regressed.",
          metrics: { score: 0.72 },
          findings: [
            {
              ruleId: "coverage",
              severity: "warn",
              message: "Add an error-path example.",
              file: "SKILL.md",
              line: 5,
            },
          ],
        },
      },
    ]);

    const evaluated = await evaluateSkillProposal({
      workspaceDir,
      agentId: "main",
      proposalId: proposal.record.id,
      expectedDraftHash: proposal.record.draftHash,
      correlationId: "optimization-run-1",
    });

    expect(evaluated.evaluation).toMatchObject({
      proposedVersion: "v1",
      draftHash: proposal.record.draftHash,
      trigger: "manual",
      correlationId: "optimization-run-1",
      outcomes: [
        {
          evaluatorId: "nvidia.skill-eval",
          pluginId: "nvidia-tools",
          pluginVersion: "1.2.3",
          status: "completed",
          result: {
            evaluatorVersion: "rules-7",
            decision: "revise",
            metrics: { score: 0.72 },
          },
        },
      ],
    });
    const hookEvent = hookMocks.evaluate.mock.calls[0]?.[0] as PluginHookSkillProposalEvaluateEvent;
    expect(hookEvent).toMatchObject({
      proposal: {
        id: proposal.record.id,
        revision: "v1",
        draftSha256: proposal.record.draftHash,
      },
      candidate: {
        skillMd: { path: "SKILL.md", encoding: "utf8" },
        files: [{ path: "references/input.txt", encoding: "utf8" }],
      },
      reason: "manual",
    });
    await expect(inspectSkillProposal(proposal.record.id, { workspaceDir })).resolves.toMatchObject(
      {
        record: { evaluation: { id: evaluated.evaluation.id } },
      },
    );
    expect(
      listSkillProposalEvents({ workspaceDir, proposalId: proposal.record.id }).events.map(
        (event) => event.type,
      ),
    ).toEqual(["created", "evaluation_completed"]);

    const revised = await reviseSkillProposal({
      workspaceDir,
      agentId: "main",
      proposalId: proposal.record.id,
      expectedDraftHash: proposal.record.draftHash,
      content: "# Evaluation Demo\n\nImproved.\n",
    });
    expect(revised.record.evaluation).toBeUndefined();
    expect(
      listSkillProposalEvents({ workspaceDir, proposalId: proposal.record.id }).events.map(
        (event) => event.type,
      ),
    ).toEqual(["created", "evaluation_completed", "revised"]);
  });

  it("overlays update candidates and discards results after a concurrent revision", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-update-");
    const skillDir = path.join(workspaceDir, "skills", "existing");
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: existing\ndescription: Existing skill\n---\n\n# Existing\n",
    );
    await fs.writeFile(path.join(skillDir, "references", "keep.txt"), "keep\n");
    await fs.writeFile(path.join(skillDir, "references", "replace.txt"), "before\n");
    const proposal = await proposeUpdateSkill({
      workspaceDir,
      agentId: "main",
      skillName: "existing",
      content: "# Existing\n\nUpdated.\n",
      supportFiles: [{ path: "references/replace.txt", content: "after\n" }],
    });
    let release: (() => void) | undefined;
    hookMocks.evaluate.mockImplementation(async (event: PluginHookSkillProposalEvaluateEvent) => {
      expect(event.baseline?.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "references/keep.txt", content: "keep\n" }),
          expect.objectContaining({ path: "references/replace.txt", content: "before\n" }),
        ]),
      );
      expect(event.candidate.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "references/keep.txt", content: "keep\n" }),
          expect.objectContaining({ path: "references/replace.txt", content: "after\n" }),
        ]),
      );
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [];
    });

    const evaluating = evaluateSkillProposal({
      workspaceDir,
      agentId: "main",
      proposalId: proposal.record.id,
      expectedDraftHash: proposal.record.draftHash,
    });
    await vi.waitFor(() => expect(hookMocks.evaluate).toHaveBeenCalledOnce());
    await reviseSkillProposal({
      workspaceDir,
      agentId: "main",
      proposalId: proposal.record.id,
      expectedDraftHash: proposal.record.draftHash,
      content: "# Existing\n\nConcurrent revision.\n",
    });
    release?.();

    await expect(evaluating).rejects.toThrow("changed while evaluation was running");
    await expect(inspectSkillProposal(proposal.record.id, { workspaceDir })).resolves.toMatchObject(
      {
        record: { proposedVersion: "v2" },
      },
    );
    expect(
      (await inspectSkillProposal(proposal.record.id, { workspaceDir }))?.record.evaluation,
    ).toBe(undefined);
  });
});
