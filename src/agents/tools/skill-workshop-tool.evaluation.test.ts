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

afterEach(async () => {
  evaluatorMocks.enabled = false;
  evaluatorMocks.evaluate.mockReset();
  await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup()));
  await tempDirs.cleanup();
});

describe("skill_workshop evaluation", () => {
  it("returns bounded decision counts without exposing private evaluator details", async () => {
    const testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skill-workshop-evaluation-state-",
    });
    cleanups.push(async () => await testState.cleanup());
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-evaluation-");
    const tool = createSkillWorkshopTool({ workspaceDir, agentId: "main", env: testState.env });
    const created = await tool.execute("create", {
      action: "create",
      name: "Evaluated Skill",
      description: "Exercise model-visible evaluation results",
      proposal_content: "# Evaluated Skill\n",
    });
    const proposal = created.details as { id: string; revisionHash: string };

    evaluatorMocks.enabled = true;
    const completed = (evaluatorId: string, decision?: "pass" | "revise" | "block") => ({
      evaluatorId,
      pluginId: "quality",
      status: "completed",
      result: decision ? { decision, summary: `private ${decision} summary` } : { metrics: {} },
    });
    evaluatorMocks.evaluate.mockResolvedValue([
      {
        evaluatorId: "pass-rules",
        pluginId: "quality",
        status: "completed",
        result: {
          decision: "pass",
          decisionReason: "private pass reason",
          summary: "private pass summary",
          metrics: { score: 0.8 },
          findings: [
            { ruleId: "critical-rule", severity: "critical", message: "critical finding" },
            { ruleId: "warn-rule", severity: "warn", message: "warn finding" },
            { ruleId: "info-rule", severity: "info", message: "info finding" },
          ],
        },
      },
      {
        evaluatorId: "metrics-only",
        pluginId: "quality",
        status: "completed",
        result: { metrics: { coverage: 0.75 } },
      },
      { evaluatorId: "offline", pluginId: "quality", status: "error", error: "private error" },
      completed("revise-rules", "revise"),
      completed("block-rules", "block"),
      { evaluatorId: "optional", pluginId: "quality", status: "skipped" },
    ]);

    const evaluated = await tool.execute("evaluate", {
      action: "evaluate",
      proposal_id: proposal.id,
      expected_revision_hash: proposal.revisionHash,
    });
    const visible = evaluated.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    expect(visible).toContain("Decisions: pass=1, revise=1, block=1, none=1; errors=1; skipped=1.");
    expect(visible).toContain("skill_workshop action=inspect");
    expect(visible.length).toBeLessThan(1_000);
    expect(visible).not.toContain("private");
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
    const inspectVisible = inspected.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    expect(inspectVisible).toContain("private pass reason");
    expect(inspectVisible).toContain("critical finding");
    expect(inspectVisible).toContain("warn finding");
    expect(inspectVisible).toContain("info finding");
    expect(inspectVisible).toContain('"score":0.8');
    expect(inspectVisible).toContain('"coverage":0.75');
    expect(inspectVisible).toContain("private error");
  });

  it("bounds adversarial evaluator details with an explicit truncation marker", async () => {
    const testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skill-workshop-evaluation-bound-state-",
    });
    cleanups.push(async () => await testState.cleanup());
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-evaluation-bound-");
    const tool = createSkillWorkshopTool({ workspaceDir, agentId: "main", env: testState.env });
    const created = await tool.execute("create", {
      action: "create",
      name: "Bounded Evaluation",
      description: "Exercise evaluator projection bounds",
      proposal_content: "# Bounded Evaluation\n",
    });
    const proposal = created.details as { id: string; revisionHash: string };

    evaluatorMocks.enabled = true;
    evaluatorMocks.evaluate.mockResolvedValue([
      {
        evaluatorId: "adversarial",
        pluginId: "quality",
        status: "completed",
        result: {
          decision: "revise",
          decisionReason: "r".repeat(2_000),
          summary: "s".repeat(4_000),
          findings: Array.from({ length: 64 }, (_, index) => ({
            ruleId: `rule-${index}`,
            severity: index % 2 === 0 ? "critical" : "warn",
            message: "f".repeat(2_000),
          })),
        },
      },
    ]);
    await tool.execute("evaluate", {
      action: "evaluate",
      proposal_id: proposal.id,
      expected_revision_hash: proposal.revisionHash,
    });
    const inspected = await tool.execute("inspect", {
      action: "inspect",
      proposal_id: proposal.id,
    });
    const visible = inspected.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const projectionStart = visible.indexOf("[{");
    const projectionEnd = visible.indexOf("\n\n---", projectionStart);
    const evaluationProjection = visible.slice(projectionStart, projectionEnd);
    expect(evaluationProjection.length).toBeLessThanOrEqual(620);
    expect(evaluationProjection).toContain("[truncated:");
  });
});
