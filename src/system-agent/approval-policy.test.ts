import { describe, expect, it } from "vitest";
import { ApprovalsSchema } from "../config/zod-schema.approvals.js";
import { shouldAlwaysApproveDelegatedSystemAgentOperations } from "./approval-policy.js";

describe("system-agent approval policy", () => {
  it("keeps prompt as the default", () => {
    expect(
      shouldAlwaysApproveDelegatedSystemAgentOperations({
        config: {},
        delegated: true,
      }),
    ).toBe(false);
  });

  it("always approves only explicitly configured delegated operations", () => {
    const config = { approvals: { systemAgent: { mode: "always" as const } } };

    expect(
      shouldAlwaysApproveDelegatedSystemAgentOperations({ config, delegated: true }),
    ).toBe(true);
    expect(
      shouldAlwaysApproveDelegatedSystemAgentOperations({ config, delegated: false }),
    ).toBe(false);
  });

  it("validates prompt and always while rejecting unknown modes", () => {
    expect(ApprovalsSchema.safeParse({ systemAgent: { mode: "prompt" } }).success).toBe(true);
    expect(ApprovalsSchema.safeParse({ systemAgent: { mode: "always" } }).success).toBe(true);
    expect(ApprovalsSchema.safeParse({ systemAgent: { mode: "session" } }).success).toBe(false);
  });
});
