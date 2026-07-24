import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import policyPlugin from "./index.js";

describe("policy plugin", () => {
  it("registers its conformance readiness criterion", () => {
    const registerReadinessCriterion = vi.fn();

    policyPlugin.register(
      createTestPluginApi({
        id: "policy",
        name: "Policy",
        source: "test",
        registerReadinessCriterion,
      }),
    );

    expect(registerReadinessCriterion).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "conformant",
        description: expect.stringContaining("no findings"),
        check: expect.any(Function),
      }),
    );
  });
});
