import { describe, expect, it } from "vitest";
import { deriveGoalSessionTitle } from "./derive-goal-session-title.js";

describe("deriveGoalSessionTitle", () => {
  it("returns undefined for empty or whitespace input", () => {
    expect(deriveGoalSessionTitle(undefined)).toBeUndefined();
    expect(deriveGoalSessionTitle("")).toBeUndefined();
    expect(deriveGoalSessionTitle("   ")).toBeUndefined();
  });

  it("skips slash commands", () => {
    expect(deriveGoalSessionTitle("/new")).toBeUndefined();
    expect(deriveGoalSessionTitle("/model openai/gpt-5.4")).toBeUndefined();
  });

  it("prefers a task-verb sentence over earlier banter", () => {
    expect(
      deriveGoalSessionTitle("Hey. Investigate why heartbeat failed overnight."),
    ).toBe("Investigate why heartbeat failed overnight.");
  });

  it("sentence-cases a plain first-bubble topic", () => {
    expect(deriveGoalSessionTitle("compare tang session naming with openclaw")).toBe(
      "Compare tang session naming with openclaw",
    );
  });

  it("strips inbound metadata before deriving", () => {
    expect(
      deriveGoalSessionTitle(
        "[Mon 2026-08-10 12:00 UTC] investigate why heartbeat failed overnight",
      ),
    ).toBe("Investigate why heartbeat failed overnight");
  });

  it("ignores host envelope leftovers that are not a user task", () => {
    expect(deriveGoalSessionTitle("<environment_context>\n{}\n</environment_context>")).toBeUndefined();
    expect(
      deriveGoalSessionTitle("<recommended_plugins>\nHere is a list of plugins\n"),
    ).toBeUndefined();
  });

  it("truncates long goals at a word boundary within 60 characters", () => {
    const result = deriveGoalSessionTitle(
      "investigate the long gateway timeout that keeps happening when the utility model cannot name sessions during onboarding",
    );
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(60);
    expect(result!.endsWith("…")).toBe(true);
  });
});
