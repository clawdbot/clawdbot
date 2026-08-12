import { describe, expect, it } from "vitest";
import {
  resolveScheduledToolCallerContext,
  resolveScheduledToolPolicyContext,
} from "./scheduled-tool-policy.js";

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
      ownerChannel: "discord",
    });
  });

  it("preserves account provenance without a canonical owner channel", () => {
    expect(
      resolveScheduledToolPolicyContext({
        toolsAllow: [],
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:main",
          ownerAccountId: "work",
        },
      }),
    ).toEqual({
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:main",
      ownerAccountId: "work",
    });
  });
});

describe("resolveScheduledToolCallerContext", () => {
  it("uses account-bound creator identity without changing delivery identity", () => {
    expect(
      resolveScheduledToolCallerContext({
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:ops",
          ownerAccountId: "creator",
          ownerChannel: "discord",
        },
        accountId: "delivery",
        channel: "telegram",
      }),
    ).toEqual({ accountId: "creator", channel: "discord" });
  });

  it("makes an unprovable account-bound channel explicitly unavailable", () => {
    expect(
      resolveScheduledToolCallerContext({
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:main",
          ownerAccountId: "creator",
        },
        accountId: "delivery",
        channel: "telegram",
      }),
    ).toEqual({ accountId: "creator", channel: null });
  });
});
