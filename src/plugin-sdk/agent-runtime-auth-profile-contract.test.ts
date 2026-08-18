import { describe, expect, it } from "vitest";
import {
  type AuthProfileFailureReason,
  type AuthProfileStore,
  resolveProfilesUnavailableReason,
} from "./agent-runtime.js";

type CooldownReason = NonNullable<AuthProfileStore["usageStats"]>[string]["cooldownReason"];

const cases = [
  { cooldownReason: "wham_token_expired", expected: "auth" },
  { cooldownReason: "wham_account_dead", expected: "auth_permanent" },
] satisfies Array<{
  cooldownReason: CooldownReason;
  expected: AuthProfileFailureReason;
}>;

describe("agent-runtime auth profile contract", () => {
  it.each(cases)("projects $cooldownReason to $expected", ({ cooldownReason, expected }) => {
    const now = 1_700_000_000_000;
    const profileId = "openai:default";
    const store: AuthProfileStore = {
      version: 1,
      profiles: {},
      usageStats: {
        [profileId]: {
          cooldownUntil: now + 60_000,
          cooldownReason,
        },
      },
    };

    expect(resolveProfilesUnavailableReason({ store, profileIds: [profileId], now })).toBe(
      expected,
    );
  });
});
