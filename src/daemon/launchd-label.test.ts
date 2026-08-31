// Launchd label tests keep lifecycle, handoff, update, and discovery resolution aligned.
import { describe, expect, it } from "vitest";
import { resolveLaunchAgentLabel } from "./launchd-label.js";

describe("resolveLaunchAgentLabel", () => {
  it("resolves default, profile, and explicit labels", () => {
    expect(resolveLaunchAgentLabel()).toBe("ai.openclaw.gateway");
    expect(resolveLaunchAgentLabel({ OPENCLAW_PROFILE: "work" })).toBe("ai.openclaw.work");
    expect(
      resolveLaunchAgentLabel({
        OPENCLAW_PROFILE: "work",
        OPENCLAW_LAUNCHD_LABEL: "com.example.gateway",
      }),
    ).toBe("com.example.gateway");
  });

  it("rejects labels that cannot be passed safely to launchd", () => {
    expect(() =>
      resolveLaunchAgentLabel({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.$(echo injected)" }),
    ).toThrow("Invalid launchd label");
  });
});
