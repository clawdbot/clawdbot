import { describe, expect, it } from "vitest";
import { applyExecPolicyLayer } from "./exec-policy.js";

describe("applyExecPolicyLayer", () => {
  it("preserves caller fields when applying a mode layer", () => {
    const result = applyExecPolicyLayer(
      {
        ask: "on-miss" as const,
        host: "node",
        security: "allowlist" as const,
      },
      { mode: "full" },
    );

    expect(result).toEqual({
      ask: "off",
      autoReview: false,
      host: "node",
      mode: "full",
      security: "full",
    });
  });

  it("preserves caller fields but clears stale mode when applying explicit policy fields", () => {
    const result = applyExecPolicyLayer(
      {
        ask: "on-miss" as const,
        host: "node",
        mode: "auto" as const,
        security: "allowlist" as const,
      },
      { security: "deny" },
    );

    expect(result).toEqual({
      ask: "on-miss",
      host: "node",
      security: "deny",
    });
  });
});
