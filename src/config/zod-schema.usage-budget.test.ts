import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";

describe("usage budget warning schema", () => {
  it("accepts warning-only daily USD budgets in defaults and agent entries", () => {
    const usageBudget = { daily: { usd: 10 }, action: "warn" } as const;
    expect(AgentDefaultsSchema.parse({ usageBudget })).toEqual({ usageBudget });
    expect(AgentEntrySchema.parse({ id: "main", usageBudget }).usageBudget).toEqual(usageBudget);
  });

  it("accepts an explicit per-agent disable", () => {
    expect(
      AgentEntrySchema.parse({ id: "main", usageBudget: { enabled: false } }).usageBudget,
    ).toEqual({ enabled: false });
  });

  it("rejects enforcement actions and incomplete warning budgets", () => {
    expect(
      AgentDefaultsSchema.safeParse({
        usageBudget: { daily: { usd: 10 }, action: "block" },
      }).success,
    ).toBe(false);
    expect(AgentDefaultsSchema.safeParse({ usageBudget: { daily: { usd: 10 } } }).success).toBe(
      false,
    );
    expect(
      AgentDefaultsSchema.safeParse({
        usageBudget: { daily: { usd: 0 }, action: "warn" },
      }).success,
    ).toBe(false);
    expect(
      AgentDefaultsSchema.safeParse({
        usageBudget: { daily: { usd: 0.0000001 }, action: "warn" },
      }).success,
    ).toBe(false);
    expect(
      AgentDefaultsSchema.safeParse({
        usageBudget: { daily: { usd: 0.0000014 }, action: "warn" },
      }).success,
    ).toBe(false);
  });
});
