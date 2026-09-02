// Fallback add/remove must resolve manifest provider aliases the same way the
// add target does, otherwise aliased entries duplicate and become unremovable.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { addFallbackCommand, removeFallbackCommand } from "./fallbacks-shared.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: (...args: unknown[]) => mocks.readConfigFileSnapshot(...args),
  replaceConfigFile: (...args: unknown[]) => mocks.replaceConfigFile(...args),
}));

const FALLBACK_PARAMS = {
  label: "Fallbacks",
  key: "model" as const,
  notFoundLabel: "Fallback",
};

function makeRuntime(): RuntimeEnv {
  return { log: () => {}, error: () => {}, exit: () => {} } as unknown as RuntimeEnv;
}

function primeConfig(sourceConfig: OpenClawConfig) {
  mocks.readConfigFileSnapshot.mockResolvedValue({
    valid: true,
    hash: "snapshot-hash",
    sourceConfig,
    config: sourceConfig,
    runtimeConfig: sourceConfig,
  });
}

function configWithFallbacks(fallbacks: string[]): OpenClawConfig {
  return { agents: { defaults: { model: { fallbacks } } } } as unknown as OpenClawConfig;
}

describe("fallback commands with manifest provider aliases", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockReset();
    mocks.replaceConfigFile.mockReset();
  });

  it("does not duplicate a fallback stored under a provider alias", async () => {
    primeConfig(configWithFallbacks(["moonshotai/kimi-k2-thinking"]));

    const updated = await addFallbackCommand(
      FALLBACK_PARAMS,
      "moonshot/kimi-k2-thinking",
      makeRuntime(),
    ).then(() => mocks.replaceConfigFile.mock.calls.at(-1)?.[0]?.nextConfig as OpenClawConfig);

    expect(updated.agents?.defaults?.model).toEqual({
      fallbacks: ["moonshotai/kimi-k2-thinking"],
    });
  });

  it("removes a fallback stored under a provider alias", async () => {
    primeConfig(configWithFallbacks(["moonshotai/kimi-k2-thinking"]));

    await removeFallbackCommand(FALLBACK_PARAMS, "moonshotai/kimi-k2-thinking", makeRuntime());

    const nextConfig = mocks.replaceConfigFile.mock.calls.at(-1)?.[0]?.nextConfig as OpenClawConfig;
    expect(nextConfig.agents?.defaults?.model).toEqual({ fallbacks: [] });
  });
});
