import { describe, expect, it } from "vitest";
import { formatAuthDoctorHint } from "./auth-profiles/doctor.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

const EMPTY_STORE: AuthProfileStore = {
  version: 1,
  profiles: {},
};

describe("formatAuthDoctorHint", () => {
  it("does not report restored qwen portal auth as removed", async () => {
    const hint = await formatAuthDoctorHint({
      store: EMPTY_STORE,
      provider: "qwen-portal",
    });

    expect(hint).toBe("");
  });

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
