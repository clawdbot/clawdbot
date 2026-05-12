import { describe, expect, it } from "vitest";
import { formatAuthDoctorHint } from "./auth-profiles/doctor.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

const EMPTY_STORE: AuthProfileStore = {
  version: 1,
  profiles: {},
};

describe("formatAuthDoctorHint", () => {
  it("guides removed qwen portal users to model studio onboarding", async () => {
    const hint = await formatAuthDoctorHint({
      store: EMPTY_STORE,
      provider: "qwen-portal",
    });

    expect(hint).toBe(
      "Qwen OAuth via portal.qwen.ai has been deprecated. Please migrate to Qwen Cloud Coding Plan. Run: openclaw onboard --auth-choice qwen-api-key (or qwen-api-key-cn for the China endpoint). Legacy modelstudio auth-choice ids still work.",
    );
  });
});
