import { describe, expect, it } from "vitest";
import { resolveScheduledToolPolicyContext } from "./scheduled-tool-policy.js";

describe("resolveScheduledToolPolicyContext", () => {
  it("requires both a persisted cap and valid server provenance", () => {
    expect(
      resolveScheduledToolPolicyContext({
        scheduledToolPolicy: { version: 1, mode: "trusted" },
      }),
    ).toBeUndefined();
    expect(
      resolveScheduledToolPolicyContext({
        toolsAllow: ["write"],
      }),
    ).toBeUndefined();
    expect(
      resolveScheduledToolPolicyContext({
        toolsAllow: ["write"],
        scheduledToolPolicy: { version: 2, mode: "trusted" },
      }),
    ).toBeUndefined();
    expect(
      resolveScheduledToolPolicyContext({ toolsAllow: ["write"], scheduledToolPolicy: {} }),
    ).toBeUndefined();
  });

  it("normalizes account provenance for explicitly capped runs", () => {
    expect(
      resolveScheduledToolPolicyContext({
        toolsAllow: [],
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: " agent:main:discord:group:ops ",
          ownerAccountId: " work ",
        },
      }),
    ).toEqual({
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:discord:group:ops",
      ownerAccountId: "work",
    });
  });
});
