import { describe, expect, it } from "vitest";
import { isSandboxProvisioningError, toSandboxProvisioningError } from "./provisioning-error.js";

describe("sandbox provisioning errors", () => {
  it("preserves an existing typed error", () => {
    const error = toSandboxProvisioningError(new Error("missing image"), "docker");

    expect(toSandboxProvisioningError(error, "other")).toBe(error);
  });

  it("recognizes provisioning failures through wrapper causes", () => {
    const provisioningError = toSandboxProvisioningError(
      new Error("backend unavailable"),
      "docker",
    );
    const wrapped = new Error("agent setup failed", { cause: provisioningError });

    expect(isSandboxProvisioningError(wrapped)).toBe(true);
    expect(isSandboxProvisioningError(new Error("provider failed"))).toBe(false);
  });
});
