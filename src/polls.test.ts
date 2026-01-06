import { describe, expect, it } from "vitest";

import { normalizePollDurationHours, normalizePollInput } from "./polls.js";

describe("polls", () => {
  it("normalizes question/options and validates maxSelections", () => {
    expect(
      normalizePollInput({
        question: "  Lunch? ",
        options: [" Pizza ", " ", "Sushi"],
        maxSelections: 2,
      }),
    ).toEqual({
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      maxSelections: 2,
      durationHours: undefined,
    });
  });

  it("enforces max option count when configured", () => {
    expect(() =>
      normalizePollInput(
        { question: "Q", options: ["A", "B", "C"] },
        { maxOptions: 2 },
      ),
    ).toThrow(/at most 2/);
  });

  it("clamps poll duration with defaults", () => {
    expect(
      normalizePollDurationHours(undefined, { defaultHours: 24, maxHours: 48 }),
    ).toBe(24);
    expect(
      normalizePollDurationHours(999, { defaultHours: 24, maxHours: 48 }),
    ).toBe(48);
    expect(
      normalizePollDurationHours(1, { defaultHours: 24, maxHours: 48 }),
    ).toBe(1);
  });
});
