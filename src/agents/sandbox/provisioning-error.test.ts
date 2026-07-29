import { describe, expect, it } from "vitest";
import {
  isSandboxProvisioningError,
  SandboxProvisioningError,
  toSandboxProvisioningError,
} from "./provisioning-error.js";

describe("sandbox provisioning errors", () => {
  it("preserves an existing typed error", () => {
    const error = new SandboxProvisioningError("missing image", { backendId: "docker" });

    expect(toSandboxProvisioningError(error, "other")).toBe(error);
  });

  it("recognizes provisioning failures through wrapper causes", () => {
    const provisioningError = new SandboxProvisioningError("backend unavailable", {
      backendId: "docker",
    });
    const wrapped = new Error("agent setup failed", { cause: provisioningError });

    expect(isSandboxProvisioningError(wrapped)).toBe(true);
    expect(isSandboxProvisioningError(new Error("provider failed"))).toBe(false);
  });
});
