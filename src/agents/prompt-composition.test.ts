import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPromptCompositionScenarios,
  type PromptScenario,
} from "../../test/helpers/agents/prompt-composition-scenarios.js";

type ScenarioFixture = Awaited<ReturnType<typeof createPromptCompositionScenarios>>;

function getTurn(scenario: PromptScenario, id: string) {
  const turn = scenario.turns.find((entry) => entry.id === id);
  expect(turn, `${scenario.scenario}:${id}`).toBeDefined();
  return turn!;
}

describe("prompt composition invariants", () => {
  let fixture: ScenarioFixture;

  beforeAll(async () => {
    fixture = await createPromptCompositionScenarios();
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it("keeps the system prompt stable after warmup for normal user-turn scenarios", () => {
    for (const scenario of fixture.scenarios) {
      if (scenario.expectedStableSystemAfterTurnIds.length === 0) {
        continue;
      }
      for (const turnId of scenario.expectedStableSystemAfterTurnIds) {
        const current = getTurn(scenario, turnId);
        const index = scenario.turns.findIndex((entry) => entry.id === turnId);
        const previous = scenario.turns[index - 1];
        expect(previous, `${scenario.scenario}:${turnId}:previous`).toBeDefined();
        expect(current.systemPrompt, `${scenario.scenario}:${turnId}`).toBe(previous.systemPrompt);
      }
    }
  });

  it("keeps bootstrap warnings out of the system prompt and preserves the original user prompt prefix", () => {
    const scenario = fixture.scenarios.find((entry) => entry.scenario === "bootstrap-warning");
    expect(scenario).toBeDefined();
    const first = getTurn(scenario!, "t1");
    const deduped = getTurn(scenario!, "t2");
    const always = getTurn(scenario!, "t3");

    expect(first.systemPrompt).not.toContain("[Bootstrap truncation warning]");
    expect(first.systemPrompt).toContain("[...truncated, read AGENTS.md for full content...]");
    expect(first.bodyPrompt.startsWith("hello")).toBe(true);
    expect(first.bodyPrompt).toContain("[Bootstrap truncation warning]");

    expect(deduped.bodyPrompt).toBe("hello again");
    expect(always.bodyPrompt.startsWith("one more turn")).toBe(true);
    expect(always.bodyPrompt).toContain("[Bootstrap truncation warning]");
  });

  it("keeps the group auto-reply prompt dynamic only across the first-turn intro boundary", () => {
    const groupScenario = fixture.scenarios.find((entry) => entry.scenario === "auto-reply-group");
    expect(groupScenario).toBeDefined();
    const first = getTurn(groupScenario!, "t1");
    const steady = getTurn(groupScenario!, "t2");
    const eventTurn = getTurn(groupScenario!, "t3");

    expect(first.systemPrompt).toContain("You are in a Slack group chat.");
    expect(first.systemPrompt).toContain("Activation: trigger-only");
    expect(steady.systemPrompt).toContain("You are in a Slack group chat.");
    expect(steady.systemPrompt).not.toContain("Activation: trigger-only");
    expect(first.systemPrompt).not.toBe(steady.systemPrompt);
    expect(steady.systemPrompt).toBe(eventTurn.systemPrompt);
  });

  it("keeps maintenance prompts out of the normal stable-turn invariant set", () => {
    const maintenanceScenario = fixture.scenarios.find(
      (entry) => entry.scenario === "maintenance-prompts",
    );
    expect(maintenanceScenario).toBeDefined();
    const flush = getTurn(maintenanceScenario!, "t1");
    const refresh = getTurn(maintenanceScenario!, "t2");

    expect(flush.systemPrompt).not.toBe(refresh.systemPrompt);
    expect(flush.bodyPrompt).toContain("Pre-compaction memory flush.");
    expect(refresh.bodyPrompt).toContain("[Post-compaction context refresh]");
  });
});
