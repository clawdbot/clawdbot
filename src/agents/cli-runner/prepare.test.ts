import { describe, expect, it } from "vitest";
import { shouldSkipLocalCliCredentialEpoch } from "./prepare.js";

describe("shouldSkipLocalCliCredentialEpoch", () => {
  it("skips local cli auth only when a profile-owned execution was prepared", () => {
    expect(
      shouldSkipLocalCliCredentialEpoch({
        authEpochMode: "profile-only",
        authProfileId: "openai-codex:default",
        authCredential: {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
        preparedExecution: {
          env: {
            CODEX_HOME: "/tmp/codex-home",
          },
        },
      }),
    ).toBe(true);
  });

  it("keeps local cli auth in the epoch when the selected profile has no bridgeable execution", () => {
    expect(
      shouldSkipLocalCliCredentialEpoch({
        authEpochMode: "profile-only",
        authProfileId: "openai-codex:default",
        authCredential: undefined,
        preparedExecution: null,
      }),
    ).toBe(false);
  });
});
