import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { __testing as setupRegistryRuntimeTesting } from "../plugins/setup-registry.runtime.js";
import { isCliProvider } from "./model-selection-cli.js";

describe("isCliProvider", () => {
  beforeEach(() => {
    setupRegistryRuntimeTesting.resetRuntimeState();
    setupRegistryRuntimeTesting.setRuntimeModuleForTest({
      resolvePluginSetupCliBackend: ({ backend }) =>
        backend === "claude-cli"
          ? {
              pluginId: "anthropic",
              backend: { id: "claude-cli", config: { command: "claude" } },
            }
          : undefined,
    });
  });

  afterEach(() => {
    setupRegistryRuntimeTesting.resetRuntimeState();
  });

  it("returns true for setup-registered cli backends", () => {
    expect(isCliProvider("claude-cli", {} as OpenClawConfig)).toBe(true);
  });

  it("accepts the anthropic-cli auth-choice id as a Claude CLI provider alias", () => {
    expect(isCliProvider("anthropic-cli", {} as OpenClawConfig)).toBe(true);
  });

  it("returns false for provider ids", () => {
    expect(isCliProvider("example-cli", {} as OpenClawConfig)).toBe(false);
  });
});
