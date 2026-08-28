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
    ["diagnostic", "diagnostic-full"],
    ["postpublish-confidence", "diagnostic-full"],
  ] as const)("maps %s to %s", (purpose, intent) => {
    expect(releaseValidationIntentForPurpose(purpose)).toBe(intent);
  });

  it("requires main qualification callers to choose daily or weekly", () => {
    expect(() => releaseValidationIntentForPurpose("main-qualification")).toThrow(
      "requires an explicit validation intent",
    );
    expect(releaseValidationIntentForPurpose("main-qualification", "main-daily")).toBe(
      "main-daily",
    );
    expect(releaseValidationIntentForPurpose("main-qualification", "main-weekly")).toBe(
      "main-weekly",
    );
    expect(() =>
      releaseValidationIntentForPurpose("main-qualification", "diagnostic-full"),
    ).toThrow("does not allow validation intent");
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
