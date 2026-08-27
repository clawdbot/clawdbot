import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

const evaluatorMocks = vi.hoisted(() => ({ enabled: false, evaluate: vi.fn() }));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (hookName: string) =>
      hookName === "skill_proposal_evaluate" && evaluatorMocks.enabled,
    runSkillProposalEvaluate: evaluatorMocks.evaluate,
  }),
}));

const tempDirs = createTrackedTempDirs();
const cleanups: Array<() => Promise<void>> = [];

async function createEvaluationFixture(name: string) {
  const testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-workshop-evaluation-state-",
  });
  cleanups.push(async () => await testState.cleanup());
  const workspaceDir = await tempDirs.make("openclaw-skill-workshop-evaluation-");
  const tool = createSkillWorkshopTool({ workspaceDir, agentId: "main", env: testState.env });
  const created = await tool.execute("create", {
    action: "create",
    name,
    description: "Exercise model-visible evaluation results",
    proposal_content: `# ${name}\n`,
  });
  return { tool, proposal: created.details as { id: string; revisionHash: string } };
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []))
    .join("\n");
}

function expectUtf16WellFormed(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      expect(next).toBeGreaterThanOrEqual(0xdc00);
      expect(next).toBeLessThanOrEqual(0xdfff);
    } else {
      expect(unit < 0xdc00 || unit > 0xdfff).toBe(true);
    }
  }
}

afterEach(async () => {
  evaluatorMocks.enabled = false;
  evaluatorMocks.evaluate.mockReset();
  await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup()));
  await tempDirs.cleanup();
});

describe("skill_workshop evaluation", () => {
  it("returns the bounded evaluator outcome directly and keeps inspect in parity", async () => {
    const { tool, proposal } = await createEvaluationFixture("Evaluated Skill");

    evaluatorMocks.enabled = true;
    const completedOutcome = {
      evaluatorId: "pass-rules",
      pluginId: "quality",
      pluginVersion: "1.2.3",
      status: "completed",
      result: {
        decision: "pass",
        decisionReason: "private pass reason",
        summary: "private pass summary",
        evaluatorVersion: "rules-7",
        mode: "static",
        metrics: { score: 0.8, coverage: 0.75 },
        findings: [
          {
            ruleId: "critical-rule",
            severity: "critical",
            message: "critical finding",
            file: "SKILL.md",
            line: 12,
          },
        ],
      },
    } as const;
    const errorOutcome = {
      evaluatorId: "offline",
      pluginId: "quality",
      status: "error",
      error: "private error",
    } as const;
    const skippedOutcome = {
      evaluatorId: "optional",
      pluginId: "quality",
      status: "skipped",
    } as const;
    evaluatorMocks.evaluate.mockResolvedValue([errorOutcome, completedOutcome, skippedOutcome]);

    const evaluated = await tool.execute("evaluate", {
      action: "evaluate",
      proposal_id: proposal.id,
      expected_revision_hash: proposal.revisionHash,
    });
    const visible = toolText(evaluated);

    expect(visible).toContain("Decisions: pass=1, revise=0, block=0, none=0; errors=1; skipped=1.");
    expect(visible).toContain('"evaluatorId":"offline","pluginId":"quality","status":"error"');
    expect(visible).toContain('"evaluatorId":"pass-rules","pluginId":"quality"');
    expect(visible).toContain('"pluginVersion":"1.2.3"');
    expect(visible).toContain('"status":"completed"');
    expect(visible).toContain('"decision":"pass"');
    expect(visible).toContain("private pass reason");
    expect(visible).toContain("private pass summary");
    expect(visible).toContain('"file":"SKILL.md"');
    expect(visible).toContain('"line":12');
    expect(visible).toContain('"message":"critical finding"');
    expect(visible).toContain('"severity":"critical"');
    expect(visible).toContain('"metrics":{"coverage":0.75,"score":0.8}');
    expect(visible).toContain('"evaluatorVersion":"rules-7"');
    expect(visible).toContain('"mode":"static"');
    expect(visible).toContain('"error":"private error"');
    expect(visible).toContain('"evaluatorId":"optional","pluginId":"quality","status":"skipped"');
    expect(visible.indexOf('"evaluatorId":"offline"')).toBeLessThan(
      visible.indexOf('"evaluatorId":"pass-rules"'),
    );
    expect(visible.indexOf('"evaluatorId":"pass-rules"')).toBeLessThan(
      visible.indexOf('"evaluatorId":"optional"'),
    );
    expect(visible.length).toBeLessThan(1_000);
    expect(visible).not.toContain("[truncated:");
    const details = evaluated.details as { evaluation: { outcomes: unknown[] } };
    expect(details.evaluation.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ result: expect.objectContaining({ decision: "pass" }) }),
      ]),
    );

    const inspected = await tool.execute("inspect", {
      action: "inspect",
      proposal_id: proposal.id,
    });
    const inspectVisible = toolText(inspected);
    expect(inspectVisible).toContain(visible.slice(visible.indexOf("Decisions:")));

    evaluatorMocks.evaluate.mockResolvedValue([
      errorOutcome,
      {
        ...completedOutcome,
        result: { ...completedOutcome.result, metrics: { coverage: 0.75, score: 0.8 } },
      },
      skippedOutcome,
    ]);
    const reevaluated = await tool.execute("evaluate", {
      action: "evaluate",
      proposal_id: proposal.id,
      expected_revision_hash: proposal.revisionHash,
    });
    expect(toolText(reevaluated)).toBe(visible);
  });

  it("bounds adversarial evaluator details with an explicit truncation marker", async () => {
    const { tool, proposal } = await createEvaluationFixture("Bounded Evaluation");

    evaluatorMocks.enabled = true;
    evaluatorMocks.evaluate.mockResolvedValue([
      {
        evaluatorId: "adversarial",
        pluginId: "quality",
        status: "completed",
        result: {
          decision: "revise",
          decisionReason: "SENSITIVE".repeat(1_000),
          summary: "😀".repeat(4_000),
          findings: Array.from({ length: 64 }, (_, index) => ({
            ruleId: `rule-${index}`,
            severity: index % 2 === 0 ? "critical" : "warn",
            message: "f".repeat(2_000),
          })),
        },
      },
    ]);
    const evaluated = await tool.execute("evaluate", {
      action: "evaluate",
      proposal_id: proposal.id,
      expected_revision_hash: proposal.revisionHash,
    });
    const evaluateVisible = toolText(evaluated);
    expect(evaluateVisible.length).toBeLessThan(1_000);
    expect(evaluateVisible).toContain(
      "[truncated: evaluator details exceed the model projection limit]",
    );
    expect(evaluateVisible).not.toContain("😀".repeat(1_000));
    expect(evaluateVisible).not.toContain("SENSITIVE".repeat(200));
    expectUtf16WellFormed(evaluateVisible);
    const details = evaluated.details as {
      evaluation: { outcomes: Array<{ result?: { decisionReason?: string; summary?: string } }> };
    };
    expect(details.evaluation.outcomes[0]?.result?.decisionReason).toHaveLength(2_000);
    expect(details.evaluation.outcomes[0]?.result?.summary).toHaveLength(8_000);
  });
});
