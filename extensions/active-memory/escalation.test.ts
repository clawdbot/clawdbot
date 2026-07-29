import { describe, expect, it } from "vitest";
import { hasRecallIntent, shouldEscalateRecall } from "./escalation.js";

describe("active-memory escalation", () => {
  it.each([
    "Do you remember what we decided?",
    "What did we discuss last time?",
    "Which database did we choose?",
    "Summarize the conversations from January",
    "¿Qué decidimos la última vez?",
    "¿Cuál fue la última vez que hablamos?",
    "Can you remind me what seat I prefer?",
    "You said earlier that the rollout was paused",
    "What happened two weeks ago?",
  ])("recognizes recall intent in %j", (message) => {
    expect(hasRecallIntent(message)).toBe(true);
  });

  it("requires recall intent and a weak deterministic lane in escalate mode", () => {
    expect(hasRecallIntent("How do I configure SQLite?")).toBe(false);
    expect(hasRecallIntent("Run the tests before merging")).toBe(false);
    expect(hasRecallIntent("Before we deploy, run the tests")).toBe(false);
    expect(hasRecallIntent("Remember to send the report")).toBe(false);
    expect(hasRecallIntent("Remind me tomorrow")).toBe(false);
    expect(hasRecallIntent("How does prior authorization work?")).toBe(false);
    expect(
      shouldEscalateRecall({
        mode: "escalate",
        message: "What did we decide last time?",
        hasStrongLaneOneHit: false,
      }),
    ).toBe(true);
    expect(
      shouldEscalateRecall({
        mode: "escalate",
        message: "What did we decide last time?",
        hasStrongLaneOneHit: true,
      }),
    ).toBe(false);
    expect(
      shouldEscalateRecall({
        mode: "escalate",
        message: "Explain the current configuration",
        hasStrongLaneOneHit: false,
      }),
    ).toBe(false);
  });

  it("preserves always mode and disables escalation in off mode", () => {
    expect(
      shouldEscalateRecall({
        mode: "always",
        message: "No recall phrasing here",
        hasStrongLaneOneHit: true,
      }),
    ).toBe(true);
    expect(
      shouldEscalateRecall({
        mode: "off",
        message: "Do you remember this?",
        hasStrongLaneOneHit: false,
      }),
    ).toBe(false);
  });
});
