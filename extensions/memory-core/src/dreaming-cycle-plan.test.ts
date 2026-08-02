import { describe, expect, it } from "vitest";
import { buildDreamingCyclePlan } from "./dreaming-cycle-plan.js";

describe("buildDreamingCyclePlan", () => {
  it("builds five ordered human-like cycles for the default night", () => {
    const plan = buildDreamingCyclePlan();
    expect(plan).toMatchObject({
      startMinute: 23 * 60,
      endMinute: 7 * 60,
      durationMinutes: 480,
      cycleMinutes: 96,
    });
    expect(plan.steps).toHaveLength(16);
    expect(plan.steps.map((step) => step.offsetMinutes)).toEqual(
      plan.steps.map((step) => step.offsetMinutes).toSorted((a, b) => a - b),
    );
    const deep = plan.steps.filter((step) => step.phase === "deep" && step.kind === "phase");
    const rem = plan.steps.filter((step) => step.phase === "rem");
    expect(deep[0]?.deepWeight).toBeGreaterThan(deep.at(-1)?.deepWeight ?? 0);
    expect(rem.at(-1)?.remWeight).toBeGreaterThan(rem[0]?.remWeight ?? 0);
    expect(plan.steps.at(-1)).toMatchObject({
      id: "final-deep-commit",
      phase: "deep",
      kind: "final-commit",
    });
    for (const [index, step] of plan.steps.entries()) {
      expect(step.requires).toEqual(index === 0 ? [] : [plan.steps[index - 1]?.id]);
    }
  });

  it("supports custom overnight and daytime windows", () => {
    expect(
      buildDreamingCyclePlan({ sleepWindow: { start: "22:30", end: "06:00" } }),
    ).toMatchObject({ durationMinutes: 450, cycleMinutes: 90 });
    expect(
      buildDreamingCyclePlan({ sleepWindow: { start: "09:00", end: "16:00" } }),
    ).toMatchObject({ durationMinutes: 420, cycleMinutes: 84 });
  });

  it.each([
    { start: "23:00", end: "23:00" },
    { start: "25:00", end: "07:00" },
    { start: "23:00", end: "02:00" },
  ])("rejects invalid sleep window $start-$end", (sleepWindow) => {
    expect(() => buildDreamingCyclePlan({ sleepWindow })).toThrow();
  });
});
