import { describe, expect, it } from "vitest";
import { hasModelSwitchContinuitySignal } from "./model-switch-eval.js";

describe("qa model-switch evaluation", () => {
  it("accepts direct handoff replies that mention the kickoff task", () => {
    expect(
      hasModelSwitchContinuitySignal(
        "Handoff confirmed: I reread QA_KICKOFF_TASK.md and switched to gpt.",
      ),
    ).toBe(true);
  });

  it("accepts short mission-oriented switch confirmations", () => {
    expect(
      hasModelSwitchContinuitySignal(
        "model switch complete. reread the kickoff task; qa mission stays the same.",
      ),
    ).toBe(true);
  });

  it("accepts concise kickoff note confirmations", () => {
    expect(
      hasModelSwitchContinuitySignal(
        "Handoff clean: after the model switch, I reread the kickoff note.",
      ),
    ).toBe(true);
  });

  it("accepts concise paraphrases of the kickoff task after a handoff", () => {
    expect(
      hasModelSwitchContinuitySignal(
        "Handoff is clear: after the model switch, read source and docs first, run seeded qa-channel scenarios, and report worked, failed, blocked, and follow-up.",
      ),
    ).toBe(true);
  });

  it("rejects unrelated handoff chatter that never confirms the kickoff reread", () => {
    expect(
      hasModelSwitchContinuitySignal(
        "subagent-handoff confirmed. qa report update: scenario pass. qa run complete.",
      ),
    ).toBe(false);
  });

  it("rejects over-scoped multi-line wrap-ups even if they mention a switch and the mission", () => {
    expect(
      hasModelSwitchContinuitySignal(
        `model switch acknowledged. qa mission stays the same.

Final QA tally update: all mandatory scenarios resolved. QA run complete.`,
      ),
    ).toBe(false);
  });
});
