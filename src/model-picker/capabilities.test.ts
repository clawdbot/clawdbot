import { describe, expect, expectTypeOf, it } from "vitest";
import type { ModelPickerCapabilityProfile } from "./capabilities.js";

describe("ModelPickerCapabilityProfile", () => {
  it("keeps presentation, callback units, and response mechanics distinct", () => {
    const profile = {
      presentation: {
        supported: true,
        buttons: true,
        selects: true,
        limits: { actions: { maxActions: 8 } },
      },
      callback: { limit: 64, unit: "utf8-bytes" },
      response: {
        supportsEphemeral: false,
        supportsEdit: true,
        supportsReplace: true,
      },
    } satisfies ModelPickerCapabilityProfile;

    expect(profile.callback).toEqual({ limit: 64, unit: "utf8-bytes" });
    expect(profile.response.supportsEdit).toBe(true);
    expectTypeOf<ModelPickerCapabilityProfile["callback"]["unit"]>().toEqualTypeOf<
      "utf8-bytes" | "utf16-units"
    >();
  });
});
