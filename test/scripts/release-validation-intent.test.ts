import { describe, expect, it } from "vitest";
import {
  releaseValidationIntentForPurpose,
  resolveReleaseValidationIntent,
} from "../../scripts/release-validation-intent.mjs";

describe("release validation intent", () => {
  it.each([
    ["release-beta", "beta", false, true],
    ["release-stable", "stable", true, true],
    ["main-daily", "beta", false, false],
    ["main-weekly", "full", true, false],
    ["diagnostic-full", "full", true, false],
  ] as const)(
    "defines %s as profile=%s soak=%s publishable=%s",
    (intent, profile, soak, publishable) => {
      expect(resolveReleaseValidationIntent(intent)).toEqual({
        intent,
        profile,
        publishable,
        soak,
      });
    },
  );

  it.each([
    ["beta-publish", "release-beta"],
    ["stable-publish", "release-stable"],
    ["postpublish-confidence", "diagnostic-full"],
    ["main-qualification", "main-weekly"],
  ] as const)("maps %s to %s", (purpose, intent) => {
    expect(releaseValidationIntentForPurpose(purpose)).toBe(intent);
  });

  it("treats legacy profile and soak inputs as assertions", () => {
    expect(
      resolveReleaseValidationIntent("main-daily", {
        profile: "beta",
        soak: false,
      }),
    ).toMatchObject({ intent: "main-daily" });
    expect(() =>
      resolveReleaseValidationIntent("main-daily", {
        profile: "full",
      }),
    ).toThrow("profile assertion conflicts");
    expect(() =>
      resolveReleaseValidationIntent("main-daily", {
        soak: true,
      }),
    ).toThrow("soak assertion conflicts");
  });
});
