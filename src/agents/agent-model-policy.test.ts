import { describe, expect, it } from "vitest";
import { resolveAgentModelPolicy } from "./agent-model-policy.js";

describe("resolveAgentModelPolicy", () => {
  it("defaults to free-first", () => {
    expect(resolveAgentModelPolicy({ agentId: "coding" })).toMatchObject({
      mode: "free-first",
      allowPaidFallback: false,
      maxFallbackAttempts: 3,
    });
  });

  it("merges agent overrides over defaults", () => {
    expect(
      resolveAgentModelPolicy({
        agentId: "coding",
        defaults: { mode: "free-only", maxFallbackAttempts: 2 },
        policies: {
          coding: { mode: "free-first", preferredModels: ["openrouter/free"] },
        },
      }),
    ).toMatchObject({
      mode: "free-first",
      preferredModels: ["openrouter/free"],
      maxFallbackAttempts: 2,
      allowPaidFallback: false,
    });
  });
});
