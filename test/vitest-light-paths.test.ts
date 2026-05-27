import { describe, expect, it } from "vitest";
import {
  isCommandsLightTarget,
  resolveCommandsLightIncludePattern,
} from "./vitest/vitest.commands-light-paths.mjs";
import {
  isPluginSdkLightTarget,
  resolvePluginSdkLightIncludePattern,
} from "./vitest/vitest.plugin-sdk-paths.mjs";

describe("light vitest path routing", () => {
  it("maps plugin-sdk allowlist source and test files to sibling light tests", () => {
    expect(isPluginSdkLightTarget("src/plugin-sdk/lazy-value.ts")).toBe(true);
    expect(isPluginSdkLightTarget("src/plugin-sdk/lazy-value.test.ts")).toBe(true);
    expect(resolvePluginSdkLightIncludePattern("src/plugin-sdk/lazy-value.ts")).toBe(
      "src/plugin-sdk/lazy-value.test.ts",
    );
    expect(resolvePluginSdkLightIncludePattern("src/plugin-sdk/lazy-value.test.ts")).toBe(
      "src/plugin-sdk/lazy-value.test.ts",
    );
  });

  it("keeps non-allowlisted plugin-sdk files off the light lane", () => {
    expect(isPluginSdkLightTarget("src/plugin-sdk/facade-runtime.ts")).toBe(false);
    expect(resolvePluginSdkLightIncludePattern("src/plugin-sdk/facade-runtime.ts")).toBeNull();
  });

  it("maps commands allowlist source and test files to sibling light tests", () => {
    expect(isCommandsLightTarget("src/commands/text-format.ts")).toBe(true);
    expect(isCommandsLightTarget("src/commands/text-format.test.ts")).toBe(true);
    expect(resolveCommandsLightIncludePattern("src/commands/text-format.ts")).toBe(
      "src/commands/text-format.test.ts",
    );
    expect(resolveCommandsLightIncludePattern("src/commands/text-format.test.ts")).toBe(
      "src/commands/text-format.test.ts",
    );
    expect(isCommandsLightTarget("src/commands/gateway-status/helpers.ts")).toBe(true);
    expect(resolveCommandsLightIncludePattern("src/commands/gateway-status/helpers.ts")).toBe(
      "src/commands/gateway-status/helpers.test.ts",
    );
  });

  it("keeps non-allowlisted commands files off the light lane", () => {
    expect(isCommandsLightTarget("src/commands/channels.add.ts")).toBe(false);
    expect(resolveCommandsLightIncludePattern("src/commands/channels.add.ts")).toBeNull();
  });

  it("can route broad command test files without narrowing their source files", () => {
    expect(isCommandsLightTarget("src/commands/auth-choice.test.ts")).toBe(true);
    expect(resolveCommandsLightIncludePattern("src/commands/auth-choice.test.ts")).toBe(
      "src/commands/auth-choice.test.ts",
    );
    expect(isCommandsLightTarget("src/commands/auth-choice.ts")).toBe(false);
    expect(resolveCommandsLightIncludePattern("src/commands/auth-choice.ts")).toBeNull();
  });
});
