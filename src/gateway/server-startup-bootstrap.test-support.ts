/** Runtime-config publication coverage loaded by the startup plugin suite. */
import { afterEach, describe, expect, it } from "vitest";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  resetConfigRuntimeState,
  setAppliedRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { testing } from "./server-startup-bootstrap.js";

const { publishGatewayPluginRuntimeConfigAtStartup } = testing;

afterEach(() => {
  resetConfigRuntimeState();
});

describe("Gateway startup runtime config publication", () => {
  it("replaces the pre-activation snapshot with the exact plugin runtime config", () => {
    const sourceConfig = {
      agents: { defaults: { model: "openai/gpt-5.2" } },
    } as OpenClawConfig;
    const preActivationConfig = structuredClone(sourceConfig);
    const pluginRuntimeConfig = {
      ...preActivationConfig,
      plugins: {
        entries: {
          openai: { enabled: true },
        },
      },
    } as OpenClawConfig;
    setAppliedRuntimeConfigSnapshot(preActivationConfig, sourceConfig);

    publishGatewayPluginRuntimeConfigAtStartup({
      runtimeConfig: pluginRuntimeConfig,
      sourceConfig,
    });

    expect(getRuntimeConfigSnapshot()).toBe(pluginRuntimeConfig);
    expect(getRuntimeConfigSourceSnapshot()).toBe(sourceConfig);
  });
});
