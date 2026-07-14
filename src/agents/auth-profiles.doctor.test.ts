/**
 * Auth-profile doctor copy tests.
 * Covers provider-specific repair hints without invoking real auth flows.
 */
import { describe, expect, it } from "vitest";
import { formatAuthDoctorHint } from "./auth-profiles/doctor.js";

describe("formatAuthDoctorHint", () => {
  it("guides legacy qwen portal oauth profiles to re-authenticate", async () => {
    const hint = await formatAuthDoctorHint({
      store: {
        version: 1,
        profiles: {
          "qwen-portal-auth": {
            type: "oauth",
            provider: "qwen-portal",
            access: "old-access",
            refresh: "old-refresh",
            expires: 0,
          },
        },
      },
      provider: "qwen-portal",
      profileId: "qwen-portal-auth",
    });

    expect(hint).toBe(
      "Legacy Qwen Portal OAuth profiles are not refreshable. Re-authenticate with a current portal token: openclaw onboard --auth-choice qwen-oauth.",
    );
  });
});
