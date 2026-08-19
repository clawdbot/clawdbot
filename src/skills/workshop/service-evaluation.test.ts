import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

import { buildSkillProposalEvaluationBundles } from "./proposal-bundle.js";
import { SkillProposalRevisionChangedError } from "./service-evaluation.js";
import {
  applySkillProposal,
  evaluateSkillProposal,
  inspectSkillProposal,
  listSkillProposalEvents,
  proposeCreateSkill,
  proposeUpdateSkill,
  reviseSkillProposal,
} from "./service.js";
import { prepareSkillProposalSupportFiles } from "./store.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeAll(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-evaluation-state-",
  });
});

beforeEach(() => {
  testState.applyEnv();
  hookMocks.evaluate.mockReset();
  hookMocks.hasEvaluators = true;
});

afterEach(async () => {
  await tempDirs.cleanup();
});

afterAll(async () => {
  await testState.cleanup();
});

async function createOwnedSkill(
  workspaceDir: string,
  name: string,
  description = "Existing skill",
): Promise<string> {
  const proposal = await proposeCreateSkill({
    workspaceDir,
    agentId: "main",
    name,
    description,
    content: `# ${name}\n`,
  });
  const hadEvaluators = hookMocks.hasEvaluators;
  hookMocks.hasEvaluators = false;
  try {
    await applySkillProposal({
      workspaceDir,
      agentId: "main",
      proposalId: proposal.record.id,
      expectedRevisionHash: proposal.revisionHash,
    });
  } finally {
    hookMocks.hasEvaluators = hadEvaluators;
  }
  return proposal.record.target.skillDir;
}

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
      targetTreeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
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
      correlationId: "optimization-run-1",
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
    const eventsAfterEvaluation = listSkillProposalEvents({
      workspaceDir,
      proposalId: proposal.record.id,
    }).events;
    expect(eventsAfterEvaluation.map((event) => event.type)).toEqual([
      "created",
      "evaluation_completed",
    ]);
    expect(eventsAfterEvaluation[1]).toMatchObject({
      evaluation: {
        id: evaluated.evaluation.id,
        outcomes: [
          {
            evaluatorId: "nvidia.skill-eval",
            pluginId: "nvidia-tools",
            result: { decision: "revise" },
          },
        ],
      },
    });

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
    expect(
      listSkillProposalEvents({ workspaceDir, proposalId: proposal.record.id }).events[1],
    ).toMatchObject({
      evaluation: { id: evaluated.evaluation.id },
    });
  });

  it("overlays update candidates and discards results after a concurrent revision", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-update-");
    const skillDir = await createOwnedSkill(workspaceDir, "existing");
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

  it.each(["skill.md", "SKILL.MD"])(
    "preserves the target marker casing in evaluation bundles for %s",
    async (skillFileName) => {
      const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-filename-");
      const skillDir = await createOwnedSkill(workspaceDir, "existing-marker-case");
      const canonicalSkillFile = path.join(skillDir, "SKILL.md");
      await fs.writeFile(
        canonicalSkillFile,
        "---\nname: existing-marker-case\ndescription: Existing skill\n---\n\n# Existing\n",
      );
      const proposal = await proposeUpdateSkill({
        workspaceDir,
        agentId: "main",
        skillName: "existing-marker-case",
        content: "# Existing\n\nUpdated.\n",
      });
      const intermediateSkillFile = path.join(skillDir, "marker.tmp");
      await fs.rename(canonicalSkillFile, intermediateSkillFile);
      await fs.rename(intermediateSkillFile, path.join(skillDir, skillFileName));

      const buildBundles = () =>
        buildSkillProposalEvaluationBundles({
          proposal,
          supportFiles: [],
        });
      if (
        !(await fs.stat(canonicalSkillFile).then(
          () => true,
          () => false,
        ))
      ) {
        await expect(buildBundles()).rejects.toThrow("missing SKILL.md");
        return;
      }

      const bundles = await buildBundles();
      expect(bundles.baseline?.skillMd.path).toBe(skillFileName);
      expect(bundles.candidate.skillMd.path).toBe(skillFileName);
      expect(bundles.candidate.files.map((file) => file.path)).not.toContain("SKILL.md");
    },
  );

  it("uses filesystem path equivalence for create support-file collisions", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-create-collision-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      agentId: "main",
      name: "Create Collision",
      description: "Reject support files that resolve to an existing target",
      content: "# Create Collision\n",
      supportFiles: [{ path: "references/input.txt", content: "candidate\n" }],
    });
    const existingFile = path.join(proposal.record.target.skillDir, "references", "INPUT.txt");
    await fs.mkdir(path.dirname(existingFile), { recursive: true });
    await fs.writeFile(existingFile, "existing\n");
    const requestedFile = path.join(proposal.record.target.skillDir, "references", "input.txt");
    const requestedFileExists = await fs.stat(requestedFile).then(
      () => true,
      () => false,
    );

    const buildBundles = () =>
      buildSkillProposalEvaluationBundles({
        proposal,
        supportFiles: prepareSkillProposalSupportFiles([
          { path: "references/input.txt", content: "candidate\n" },
        ]),
      });
    if (requestedFileExists) {
      await expect(buildBundles()).rejects.toThrow("Target support file already exists");
    } else {
      await expect(buildBundles()).resolves.toMatchObject({
        candidate: {
          files: expect.arrayContaining([
            expect.objectContaining({ path: "references/INPUT.txt" }),
            expect.objectContaining({ path: "references/input.txt" }),
          ]),
        },
      });
    }
  });

  it("rejects an oversized proposed SKILL.md after overlaying the candidate", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-candidate-file-limit-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      agentId: "main",
      name: "Candidate File Limit",
      description: "Validate the final evaluator candidate",
      content: "# Candidate File Limit\n",
    });

    await expect(
      buildSkillProposalEvaluationBundles({
        proposal: {
          ...proposal,
          content: `# Candidate File Limit\n\n${"x".repeat(1024 * 1024)}`,
        },
        supportFiles: [],
      }),
    ).rejects.toThrow("file exceeds 1048576 bytes: SKILL.md");
  });

  it("rejects a candidate whose proposed files push it over the file-count limit", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-candidate-count-limit-");
    const skillDir = await createOwnedSkill(workspaceDir, "candidate-count-limit");
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: candidate-count-limit\ndescription: Existing skill\n---\n\n# Existing\n",
    );
    await Promise.all(
      Array.from({ length: 254 }, (_, index) =>
        fs.writeFile(path.join(skillDir, "references", `${index}.txt`), "existing\n"),
      ),
    );
    const proposal = await proposeUpdateSkill({
      workspaceDir,
      agentId: "main",
      skillName: "candidate-count-limit",
      content: "# Existing\n\nUpdated.\n",
    });

    await expect(
      buildSkillProposalEvaluationBundles({
        proposal,
        supportFiles: prepareSkillProposalSupportFiles([
          { path: "references/candidate-a.txt", content: "a\n" },
          { path: "references/candidate-b.txt", content: "b\n" },
        ]),
      }),
    ).rejects.toThrow("exceeds 256 files");
  });

  it("rejects a candidate whose proposed files push it over the total-byte limit", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-candidate-byte-limit-");
    const skillDir = await createOwnedSkill(workspaceDir, "candidate-byte-limit");
    await fs.mkdir(path.join(skillDir, "assets"), { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: candidate-byte-limit\ndescription: Existing skill\n---\n\n# Existing\n",
    );
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        fs.writeFile(
          path.join(skillDir, "assets", `${index}.bin`),
          Buffer.alloc(1024 * 1024 - 1024),
        ),
      ),
    );
    const proposal = await proposeUpdateSkill({
      workspaceDir,
      agentId: "main",
      skillName: "candidate-byte-limit",
      content: "# Existing\n\nUpdated.\n",
    });

    await expect(
      buildSkillProposalEvaluationBundles({
        proposal,
        supportFiles: prepareSkillProposalSupportFiles([
          { path: "references/candidate.txt", content: "x".repeat(9 * 1024) },
        ]),
      }),
    ).rejects.toThrow("exceeds 8388608 total bytes");
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
      (await inspectSkillProposal(proposal.record.id, { workspaceDir }))!.record.evaluation,
    ).toBeUndefined();
  });

  it("discards evaluator results when the live skill baseline changes during evaluation", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-baseline-drift-");
    const skillDir = await createOwnedSkill(workspaceDir, "baseline-drift");
    const skillFile = path.join(skillDir, "SKILL.md");
    await fs.writeFile(
      skillFile,
      "---\nname: baseline-drift\ndescription: Existing skill\n---\n\n# Existing\n",
    );
    const proposal = await proposeUpdateSkill({
      workspaceDir,
      agentId: "main",
      skillName: "baseline-drift",
      content: "# Existing\n\nUpdated.\n",
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
      skillFile,
      "---\nname: baseline-drift\ndescription: Existing skill\n---\n\n# Concurrent update\n",
    );
    release?.();

    await expect(evaluating).rejects.toThrow("changed while evaluation was running");
    expect(
      (await inspectSkillProposal(proposal.record.id, { workspaceDir }))!.record.evaluation,
    ).toBeUndefined();
  });

  it("discards create evaluator results when the target appears during evaluation", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-create-drift-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      agentId: "main",
      name: "Create Drift",
      description: "Reject evaluator results after the target appears",
      content: "# Create Drift\n",
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
    await fs.mkdir(proposal.record.target.skillDir, { recursive: true });
    await fs.writeFile(
      proposal.record.target.skillFile,
      "---\nname: create-drift\ndescription: Concurrent skill\n---\n\n# Concurrent\n",
    );
    release?.();

    await expect(evaluating).rejects.toThrow("changed while evaluation was running");
    expect(
      (await inspectSkillProposal(proposal.record.id, { workspaceDir }))!.record.evaluation,
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
    ).rejects.toMatchObject({
      constructor: SkillProposalRevisionChangedError,
      expectedRevisionHash: proposal.revisionHash,
      currentRevisionHash: revised.revisionHash,
    });
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

  it("persists a blocking evaluation and refuses to apply the proposal", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-block-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      agentId: "main",
      name: "Blocked Evaluation",
      description: "Keep blocking evaluator decisions authoritative",
      content: "# Blocked Evaluation\n",
    });
    hookMocks.evaluate.mockResolvedValue([
      {
        evaluatorId: "policy",
        pluginId: "policy-plugin",
        status: "completed",
        result: {
          decision: "block",
          decisionReason: "Policy denied the candidate.",
        },
      },
    ]);

    await expect(
      applySkillProposal({
        workspaceDir,
        agentId: "main",
        proposalId: proposal.record.id,
        expectedRevisionHash: proposal.revisionHash,
      }),
    ).rejects.toThrow("Policy denied the candidate.");

    await expect(inspectSkillProposal(proposal.record.id, { workspaceDir })).resolves.toMatchObject(
      {
        record: {
          status: "pending",
          evaluation: {
            trigger: "apply",
            outcomes: [
              {
                status: "completed",
                result: { decision: "block" },
              },
            ],
          },
        },
      },
    );
    await expect(fs.access(proposal.record.target.skillFile)).rejects.toThrow();
  });

  it("omits optional evaluator strings that normalize to empty", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-empty-optionals-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      agentId: "main",
      name: "Empty Optionals",
      description: "Normalize optional evaluator metadata",
      content: "# Empty Optionals\n",
    });
    hookMocks.evaluate.mockResolvedValue([
      {
        evaluatorId: "optional-fields",
        pluginId: "evaluation-tests",
        status: "completed",
        result: {
          summary: " ",
          evaluatorVersion: "\t",
          mode: "\n",
          decisionReason: "  ",
          findings: [
            {
              ruleId: "optional-file",
              severity: "info",
              message: "No file attribution.",
              file: " ",
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
    });

    expect(evaluated.evaluation.outcomes[0]).toEqual({
      evaluatorId: "optional-fields",
      pluginId: "evaluation-tests",
      status: "completed",
      result: {
        findings: [
          {
            ruleId: "optional-file",
            severity: "info",
            message: "No file attribution.",
          },
        ],
      },
    });
  });

  it("does not split surrogate pairs when bounding evaluator text", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-surrogate-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      agentId: "main",
      name: "Surrogate Bounds",
      description: "Bound evaluator text without splitting surrogates",
      content: "# Surrogate Bounds\n",
    });
    hookMocks.evaluate.mockResolvedValue([
      {
        evaluatorId: "emoji-bounds",
        pluginId: "evaluation-tests",
        status: "completed",
        result: {
          summary: `${"s".repeat(7_999)}🙂`,
          decisionReason: `${"r".repeat(1_999)}🙂`,
          metrics: { note: `${"m".repeat(3_999)}🙂` },
        },
      },
      {
        evaluatorId: "emoji-error",
        pluginId: "evaluation-tests",
        status: "error",
        error: `${"e".repeat(1_999)}🙂`,
      },
    ]);

    const evaluated = await evaluateSkillProposal({
      workspaceDir,
      agentId: "main",
      proposalId: proposal.record.id,
      expectedRevisionHash: proposal.revisionHash,
    });

    expect(evaluated.evaluation.outcomes).toEqual([
      {
        evaluatorId: "emoji-bounds",
        pluginId: "evaluation-tests",
        status: "completed",
        result: {
          summary: "s".repeat(7_999),
          decisionReason: "r".repeat(1_999),
          metrics: { note: "m".repeat(3_999) },
        },
      },
      {
        evaluatorId: "emoji-error",
        pluginId: "evaluation-tests",
        status: "error",
        error: "e".repeat(1_999),
      },
    ]);
  });

  it("rejects evaluator results that exceed the aggregate persistence budget", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-evaluation-size-budget-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      agentId: "main",
      name: "Evaluation Size Budget",
      description: "Bound durable evaluator output",
      content: "# Evaluation Size Budget\n",
    });
    hookMocks.evaluate.mockResolvedValue([
      {
        evaluatorId: "oversized-results",
        pluginId: "evaluation-tests",
        status: "completed",
        result: {
          findings: Array.from({ length: 200 }, (_, index) => ({
            ruleId: `large-${index}`,
            severity: "warn" as const,
            message: "x".repeat(4_000),
          })),
        },
      },
    ]);

    await expect(
      evaluateSkillProposal({
        workspaceDir,
        agentId: "main",
        proposalId: proposal.record.id,
        expectedRevisionHash: proposal.revisionHash,
      }),
    ).rejects.toThrow("evaluation exceeds 524288 bytes");
    expect(
      (await inspectSkillProposal(proposal.record.id, { workspaceDir }))!.record.evaluation,
    ).toBeUndefined();
    expect(
      listSkillProposalEvents({ workspaceDir, proposalId: proposal.record.id }).events.map(
        (event) => event.type,
      ),
    ).toEqual(["created"]);
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
    const skillDir = await createOwnedSkill(workspaceDir, "large-existing", "Existing large skill");
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
