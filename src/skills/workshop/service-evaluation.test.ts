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
  hasEvaluators: true,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (hookName: string) =>
      hookName === "skill_proposal_evaluate" && hookMocks.hasEvaluators,
    runSkillProposalEvaluate: hookMocks.evaluate,
  }),
}));

import {
  applySkillProposal,
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
  hookMocks.hasEvaluators = true;
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
      expectedRevisionHash: proposal.revisionHash,
      correlationId: "optimization-run-1",
    });

    expect(evaluated.evaluation).toMatchObject({
      proposedVersion: "v1",
      revisionHash: proposal.revisionHash,
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
        revisionSha256: proposal.revisionHash,
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
      expectedRevisionHash: proposal.revisionHash,
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
      expectedRevisionHash: proposal.revisionHash,
    });
    await vi.waitFor(() => expect(hookMocks.evaluate).toHaveBeenCalledOnce());
    await reviseSkillProposal({
      workspaceDir,
      agentId: "main",
      proposalId: proposal.record.id,
      expectedRevisionHash: proposal.revisionHash,
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

  it("rejects a draft file that no longer matches its persisted revision", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-drift-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      agentId: "main",
      name: "Evaluation Drift",
      description: "Reject mixed proposal snapshots",
      content: "# Evaluation Drift\n",
    });
    await fs.writeFile(
      path.join(
        testState.stateDir,
        "skill-workshop",
        "proposals",
        proposal.record.id,
        "PROPOSAL.md",
      ),
      "# Evaluation Drift\n\nUncommitted replacement.\n",
    );

    await expect(
      evaluateSkillProposal({
        workspaceDir,
        agentId: "main",
        proposalId: proposal.record.id,
        expectedRevisionHash: proposal.revisionHash,
      }),
    ).rejects.toThrow("draft changed without updating proposal metadata");
    expect(hookMocks.evaluate).not.toHaveBeenCalled();

    await expect(
      reviseSkillProposal({
        workspaceDir,
        agentId: "main",
        proposalId: proposal.record.id,
        expectedRevisionHash: proposal.revisionHash,
        supportFiles: [{ path: "references/input.txt", content: "replacement\n" }],
      }),
    ).rejects.toThrow("draft changed without updating proposal metadata");
  });

  it("discards evaluator results when the on-disk draft changes during evaluation", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-concurrent-drift-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      agentId: "main",
      name: "Concurrent Drift",
      description: "Reject evaluator results for replaced candidate bytes",
      content: "# Concurrent Drift\n",
    });
    let release: (() => void) | undefined;
    hookMocks.evaluate.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [];
    });

    const evaluating = evaluateSkillProposal({
      workspaceDir,
      agentId: "main",
      proposalId: proposal.record.id,
      expectedRevisionHash: proposal.revisionHash,
    });
    await vi.waitFor(() => expect(hookMocks.evaluate).toHaveBeenCalledOnce());
    await fs.writeFile(
      path.join(
        testState.stateDir,
        "skill-workshop",
        "proposals",
        proposal.record.id,
        "PROPOSAL.md",
      ),
      "# Concurrent Drift\n\nReplaced while evaluating.\n",
    );
    release?.();

    await expect(evaluating).rejects.toThrow("changed while evaluation was running");
    expect(
      (await inspectSkillProposal(proposal.record.id, { workspaceDir })).record.evaluation,
    ).toBeUndefined();
  });

  it("rejects stale guards after a support-file-only revision", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-support-revision-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      agentId: "main",
      name: "Support Revision",
      description: "Exercise whole-candidate revision guards",
      content: "# Support Revision\n",
      supportFiles: [{ path: "references/input.txt", content: "before\n" }],
    });
    const revised = await reviseSkillProposal({
      workspaceDir,
      agentId: "main",
      proposalId: proposal.record.id,
      expectedRevisionHash: proposal.revisionHash,
      supportFiles: [{ path: "references/input.txt", content: "after\n" }],
    });

    expect(revised.revisionHash).not.toBe(proposal.revisionHash);
    expect(revised.record.supportFiles).toEqual([
      expect.objectContaining({ path: "references/input.txt" }),
    ]);
    await expect(
      evaluateSkillProposal({
        workspaceDir,
        agentId: "main",
        proposalId: proposal.record.id,
        expectedRevisionHash: proposal.revisionHash,
      }),
    ).rejects.toThrow("proposal revision changed");
    expect(hookMocks.evaluate).not.toHaveBeenCalled();
  });

  it("rejects empty revisions without advancing lifecycle state", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-empty-revision-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      agentId: "main",
      name: "Empty Revision",
      description: "Reject no-op revision requests",
      content: "# Empty Revision\n",
    });

    await expect(
      reviseSkillProposal({
        workspaceDir,
        agentId: "main",
        proposalId: proposal.record.id,
        expectedRevisionHash: proposal.revisionHash,
      }),
    ).rejects.toThrow("requires at least one changed field");
    expect(
      listSkillProposalEvents({ workspaceDir, proposalId: proposal.record.id }).events.map(
        (event) => event.type,
      ),
    ).toEqual(["created"]);
  });

  it("rejects evaluator overflow instead of dropping blocking decisions", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-overflow-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      agentId: "main",
      name: "Evaluation Overflow",
      description: "Reject evaluator outcome truncation",
      content: "# Evaluation Overflow\n",
    });
    hookMocks.evaluate.mockResolvedValue(
      Array.from({ length: 65 }, (_, index) => ({
        evaluatorId: `evaluator-${index}`,
        pluginId: `plugin-${index}`,
        status: "completed" as const,
        result: {
          decision: index === 64 ? ("block" as const) : ("pass" as const),
        },
      })),
    );

    await expect(
      applySkillProposal({
        workspaceDir,
        agentId: "main",
        proposalId: proposal.record.id,
        expectedRevisionHash: proposal.revisionHash,
      }),
    ).rejects.toThrow("more than 64 outcomes");
    await expect(fs.access(proposal.record.target.skillFile)).rejects.toThrow();
  });

  it("rejects oversized correlation ids before running evaluators", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-correlation-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      agentId: "main",
      name: "Evaluation Correlation",
      description: "Bound persisted orchestration identifiers",
      content: "# Evaluation Correlation\n",
    });

    await expect(
      evaluateSkillProposal({
        workspaceDir,
        agentId: "main",
        proposalId: proposal.record.id,
        expectedRevisionHash: proposal.revisionHash,
        correlationId: "x".repeat(257),
      }),
    ).rejects.toThrow("exceeds 256 characters");
    expect(hookMocks.evaluate).not.toHaveBeenCalled();

    hookMocks.evaluate.mockResolvedValue([]);
    await expect(
      evaluateSkillProposal({
        workspaceDir,
        agentId: "main",
        proposalId: proposal.record.id,
        expectedRevisionHash: proposal.revisionHash,
        correlationId: "😀".repeat(200),
      }),
    ).resolves.toMatchObject({
      evaluation: { correlationId: "😀".repeat(200) },
    });
  });

  it("applies large existing skills without evaluator bundle limits when no evaluator exists", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-no-hooks-");
    const skillDir = path.join(workspaceDir, "skills", "large-existing");
    const largeAsset = path.join(skillDir, "assets", "large.bin");
    await fs.mkdir(path.dirname(largeAsset), { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: large-existing\ndescription: Existing large skill\n---\n\n# Existing\n",
    );
    await fs.writeFile(largeAsset, Buffer.alloc(1024 * 1024 + 1));
    const proposal = await proposeUpdateSkill({
      workspaceDir,
      agentId: "main",
      skillName: "large-existing",
      content: "# Existing\n\nUpdated without evaluators.\n",
    });
    hookMocks.hasEvaluators = false;

    await expect(
      applySkillProposal({
        workspaceDir,
        agentId: "main",
        proposalId: proposal.record.id,
        expectedRevisionHash: proposal.revisionHash,
      }),
    ).resolves.toMatchObject({ record: { status: "applied" } });
    await expect(fs.stat(largeAsset)).resolves.toMatchObject({ size: 1024 * 1024 + 1 });
    expect(hookMocks.evaluate).not.toHaveBeenCalled();
  });
});
