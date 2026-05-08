import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPromptCompositionScenarios,
  type PromptScenario,
} from "../../test/helpers/agents/prompt-composition-scenarios.js";

type ScenarioFixture = Awaited<ReturnType<typeof createPromptCompositionScenarios>>;

function getTurn(scenario: PromptScenario, id: string) {
  const turn = scenario.turns.find((entry) => entry.id === id);
  if (!turn) {
    throw new Error(`expected turn ${scenario.scenario}:${id}`);
  }
  return turn;
}

function getScenario(fixture: ScenarioFixture, id: string): PromptScenario {
  const scenario = fixture.scenarios.find((entry) => entry.scenario === id);
  if (!scenario) {
    throw new Error(`expected prompt scenario ${id}`);
  }
  return scenario;
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
        if (!previous) {
          throw new Error(`expected previous turn ${scenario.scenario}:${turnId}`);
        }
        expect(current.systemPrompt, `${scenario.scenario}:${turnId}`).toBe(previous.systemPrompt);
      }
    }
  });

  it("keeps bootstrap warnings out of the system prompt and preserves the original user prompt prefix", () => {
    const scenario = getScenario(fixture, "bootstrap-warning");
    const first = getTurn(scenario, "t1");
    const deduped = getTurn(scenario, "t2");
    const always = getTurn(scenario, "t3");

    expect(first.systemPrompt).not.toContain("[Bootstrap truncation warning]");
    expect(first.systemPrompt).toContain("[...truncated, read AGENTS.md for full content...]");
    expect(first.bodyPrompt.startsWith("hello")).toBe(true);
    expect(first.bodyPrompt).toContain("[Bootstrap truncation warning]");

    expect(deduped.bodyPrompt).toBe("hello again");
    expect(always.bodyPrompt.startsWith("one more turn")).toBe(true);
    expect(always.bodyPrompt).toContain("[Bootstrap truncation warning]");
  });

  it("keeps the group auto-reply prompt dynamic only across the first-turn intro boundary", () => {
    const groupScenario = getScenario(fixture, "auto-reply-group");
    const first = getTurn(groupScenario, "t1");
    const steady = getTurn(groupScenario, "t2");
    const eventTurn = getTurn(groupScenario, "t3");

    expect(first.systemPrompt).toContain("You are in a Slack group chat.");
    expect(first.systemPrompt).toContain("prefer delegating bounded side investigations early");
    expect(first.systemPrompt).toContain("Activation: trigger-only");
    expect(first.systemPrompt).toContain('reply with exactly "NO_REPLY"');
    expect(first.systemPrompt).not.toContain("## Silent Replies");
    expect(steady.systemPrompt).toContain("You are in a Slack group chat.");
    expect(steady.systemPrompt).toContain("prefer delegating bounded side investigations early");
    expect(steady.systemPrompt).toContain('reply with exactly "NO_REPLY"');
    expect(steady.systemPrompt).not.toContain("## Silent Replies");
    expect(steady.systemPrompt).not.toContain("Activation: trigger-only");
    expect(first.systemPrompt).not.toBe(steady.systemPrompt);
    expect(steady.systemPrompt).toBe(eventTurn.systemPrompt);
  });

  it("includes direct-chat guidance that routes NO_REPLY through the default rewrite path", () => {
    const directScenario = getScenario(fixture, "auto-reply-direct");
    const first = getTurn(directScenario, "t1");

    expect(first.systemPrompt).toContain("You are in a Slack direct conversation.");
    expect(first.systemPrompt).toContain('reply with exactly "NO_REPLY"');
    expect(first.systemPrompt).toContain("so OpenClaw can send a short fallback reply");
    expect(first.systemPrompt).not.toContain("## Silent Replies");
  });

  it("keeps maintenance prompts out of the normal stable-turn invariant set", () => {
    const maintenanceScenario = getScenario(fixture, "maintenance-prompts");
    const flush = getTurn(maintenanceScenario, "t1");
    const refresh = getTurn(maintenanceScenario, "t2");

    expect(flush.systemPrompt).not.toBe(refresh.systemPrompt);
    expect(flush.bodyPrompt).toContain("Pre-compaction memory flush.");
    expect(refresh.bodyPrompt).toContain("[Post-compaction context refresh]");
  });
});
