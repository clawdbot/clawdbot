import { describe, expect, it } from "vitest";
import {
  type AuthProfileFailureReason,
  type AuthProfileStore,
  resolveProfilesUnavailableReason,
} from "./agent-runtime.js";

const cases = [
  {
    cooldownReason: "auth",
    cooldownClassification: "wham_token_expired",
    expected: "auth",
  },
  {
    cooldownReason: "auth_permanent",
    cooldownClassification: "wham_account_dead",
    expected: "auth_permanent",
  },
  {
    cooldownReason: "rate_limit",
    cooldownClassification: "wham_account_dead",
    expected: "rate_limit",
  },
] satisfies Array<{
  cooldownReason: AuthProfileFailureReason;
  cooldownClassification: NonNullable<
    NonNullable<AuthProfileStore["usageStats"]>[string]["cooldownClassification"]
  >;
  expected: AuthProfileFailureReason;
}>;

function preserveExhaustiveFailureReasonHandling(
  reason: AuthProfileFailureReason,
): AuthProfileFailureReason {
  switch (reason) {
    case "auth":
    case "auth_permanent":
    case "format":
    case "overloaded":
    case "rate_limit":
    case "billing":
    case "timeout":
    case "model_not_found":
    case "session_expired":
    case "empty_response":
    case "no_error_details":
    case "unclassified":
    case "unknown":
      return reason;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function consumeCanonicalReasonFromPublicStore(
  store: AuthProfileStore,
  profileId: string,
): AuthProfileFailureReason {
  const reason = store.usageStats?.[profileId]?.cooldownReason;
  if (!reason) {
    throw new Error("expected canonical cooldown reason");
  }
  return preserveExhaustiveFailureReasonHandling(reason);
}

describe("agent-runtime auth profile contract", () => {
  it.each(cases)(
    "keeps $cooldownReason canonical with $cooldownClassification diagnostics",
    ({ cooldownReason, cooldownClassification, expected }) => {
      const now = 1_700_000_000_000;
      const profileId = "openai:default";
      const store: AuthProfileStore = {
        version: 1,
        profiles: {},
        usageStats: {
          [profileId]: {
            cooldownUntil: now + 60_000,
            cooldownReason,
            cooldownClassification,
          },
        },
      };

      expect(consumeCanonicalReasonFromPublicStore(store, profileId)).toBe(expected);
      expect(resolveProfilesUnavailableReason({ store, profileIds: [profileId], now })).toBe(
        expected,
      );
    },
  );
});
