// Sandbox backend registry tests cover pluggable backend factory and manager
// lifecycle hooks.
import { describe, expect, it } from "vitest";
import {
  getSandboxBackendFactory,
  getSandboxBackendManager,
  registerSandboxBackend,
} from "./backend.js";

describe("sandbox backend registry", () => {
  it("registers and restores backend factories", () => {
    // Tests and optional backends install process-local factories; restore must
    // remove them so later suites see the default registry.
    const factory = async () => {
      throw new Error("not used");
    };
    const restore = registerSandboxBackend("test-backend", factory);
    expect(getSandboxBackendFactory("test-backend")).toBe(factory);
    restore();
    expect(getSandboxBackendFactory("test-backend")).toBeNull();
  });

  it("registers backend managers alongside factories", () => {
    const factory = async () => {
      throw new Error("not used");
    };
    const manager = {
      describeRuntime: async () => ({
        running: true,
        configLabelMatch: true,
      }),
      removeRuntime: async () => {},
    };
    const restore = registerSandboxBackend("test-managed", {
      factory,
      manager,
    });
    expect(getSandboxBackendFactory("test-managed")).toBe(factory);
    expect(getSandboxBackendManager("test-managed")).toBe(manager);
    restore();
    expect(getSandboxBackendManager("test-managed")).toBeNull();
  });
});
