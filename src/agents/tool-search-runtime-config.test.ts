import { afterEach, describe, expect, it } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentRuntimeToolConfig } from "./tool-runtime-config.js";
import { resolveAgentToolSearchRuntimeConfig } from "./tool-search-runtime-config.js";
import { resolveAgentToolSurfacePlan } from "./tool-surface-plan.js";

function createRuntimeConfigPair(localModelLean = true) {
  const sourceConfig = {
    agents: {
      defaults: { experimental: { localModelLean } },
      entries: { main: { default: true } },
    },
    plugins: {
      entries: {
        "example-plugin": {
          config: {
            marker: {
              source: "exec",
              provider: "example",
              id: "example/value",
            },
          },
        },
      },
    },
  } as OpenClawConfig;
  const runtimeConfig = {
    ...sourceConfig,
    plugins: {
      entries: {
        "example-plugin": {
          config: { marker: "resolved" },
        },
      },
    },
  } as OpenClawConfig;
  return { runtimeConfig, sourceConfig };
}

describe("resolveAgentToolSearchRuntimeConfig", () => {
  afterEach(() => {
    resetConfigRuntimeState();
  });

  it.each([true, false])(
    "applies Tool Search after selecting the resolved snapshot for forced replies (lean: %s)",
    (localModelLean) => {
      const { runtimeConfig, sourceConfig } = createRuntimeConfigPair(localModelLean);
      setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

      const resolved = resolveAgentToolSurfacePlan({
        config: sourceConfig,
        model: localModelLean ? undefined : { toolSearchMode: "tools" },
        forceDirectMessageTool: true,
        toolsEnabled: true,
        isRawModelRun: false,
      }).toolSearchRuntimeConfig;

      expect(resolved?.tools?.toolSearch).toEqual({
        enabled: true,
        mode: "tools",
        searchDefaultLimit: 5,
        maxSearchLimit: 10,
      });
      expect(resolved?.plugins?.entries?.["example-plugin"]?.config).toMatchObject({
        marker: "resolved",
      });
      expect(runtimeConfig.tools).toBeUndefined();
      expect(sourceConfig.plugins?.entries?.["example-plugin"]?.config).toMatchObject({
        marker: {
          source: "exec",
          provider: "example",
          id: "example/value",
        },
      });
    },
  );

  it("returns the resolved snapshot unchanged for direct-message-only tool surfaces", () => {
    const { runtimeConfig, sourceConfig } = createRuntimeConfigPair();
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    expect(
      resolveAgentToolSurfacePlan({
        config: sourceConfig,
        model: { toolSearchMode: "tools" },
        forceDirectMessageTool: true,
        toolsAllow: ["message"],
        toolsEnabled: true,
        isRawModelRun: false,
      }).toolSearchRuntimeConfig,
    ).toBe(runtimeConfig);
  });

  it("preserves an explicit config that is unrelated to the active source snapshot", () => {
    const { runtimeConfig, sourceConfig } = createRuntimeConfigPair();
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    const explicitConfig = {
      agents: { entries: { main: { default: true } } },
      plugins: {
        entries: {
          "example-plugin": { config: { marker: "explicit" } },
        },
      },
    } as OpenClawConfig;

    expect(resolveAgentRuntimeToolConfig(explicitConfig)).toBe(explicitConfig);
    expect(resolveAgentToolSearchRuntimeConfig({ config: explicitConfig })).toBe(explicitConfig);
  });

  it("uses the input config when no runtime snapshot exists", () => {
    const config = {
      agents: { entries: { main: { default: true } } },
      tools: { toolSearch: false },
    } as OpenClawConfig;

    expect(resolveAgentRuntimeToolConfig(config)).toBe(config);
    expect(resolveAgentToolSearchRuntimeConfig({ config })).toBe(config);
  });
});
