import { describe, expect, it } from "vitest";
import { resolveBuzzSubscriptionBudget } from "./subscription-budget.js";

describe("Buzz relay subscription budget", () => {
  it("reserves transport and query capacity before optional profile metadata", () => {
    expect(resolveBuzzSubscriptionBudget(1)).toEqual({ profileLimit: 2_000 });
    expect(resolveBuzzSubscriptionBudget(1_010)).toEqual({ profileLimit: 2_000 });
    expect(resolveBuzzSubscriptionBudget(1_011)).toEqual({ profileLimit: 1_800 });
    expect(resolveBuzzSubscriptionBudget(1_020)).toEqual({ profileLimit: 0 });
    expect(() => resolveBuzzSubscriptionBudget(1_021)).toThrow(
      "Buzz supports at most 1020 configured rooms per account",
    );
  });
});
