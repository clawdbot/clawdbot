import { describe, expect, it } from "vitest";
import { resolveSwarmConfig } from "./swarm-config.js";

describe("resolveSwarmConfig", () => {
  it("defaults on with the frozen limits", () => {
    expect(resolveSwarmConfig()).toEqual({
      enabled: true,
      maxConcurrent: 8,
      maxChildrenPerGroup: 50,
      maxTotalPerGroup: 200,
      waitTimeoutSecondsMax: 600,
      defaultAgentId: "",
    });
  });

  it("merges per-agent values and clamps every number", () => {
    expect(
      resolveSwarmConfig(
        {
          tools: {
            swarm: {
              enabled: true,
              maxConcurrent: 0,
              maxChildrenPerGroup: 20_000,
              maxTotalPerGroup: 2,
              waitTimeoutSecondsMax: 100_000,
              defaultAgentId: " reviewer ",
            },
          },
          agents: { entries: { main: { tools: { swarm: { maxConcurrent: 4 } } } } },
        },
        "main",
      ),
    ).toEqual({
      enabled: true,
      maxConcurrent: 4,
      maxChildrenPerGroup: 10_000,
      maxTotalPerGroup: 2,
      waitTimeoutSecondsMax: 86_400,
      defaultAgentId: "reviewer",
    });
  });

  it.each([
    { field: "maxConcurrent", fallback: 8, max: 1_000 },
    { field: "maxChildrenPerGroup", fallback: 50, max: 10_000 },
    { field: "maxTotalPerGroup", fallback: 200, max: 100_000 },
    { field: "waitTimeoutSecondsMax", fallback: 600, max: 86_400 },
  ] as const)("preserves the documented bounds for $field", ({ field, fallback, max }) => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveSwarmConfig({ tools: { swarm: { [field]: value } } })[field]).toBe(fallback);
    }
    for (const [value, expected] of [
      [1, 1],
      [max, max],
      [max + 1, max],
    ]) {
      expect(resolveSwarmConfig({ tools: { swarm: { [field]: value } } })[field]).toBe(expected);
    }
  });

  it.each([
    { name: "omitted tools", config: {}, enabled: true },
    { name: "omitted swarm", config: { tools: {} }, enabled: true },
    { name: "empty swarm", config: { tools: { swarm: {} } }, enabled: true },
    {
      name: "limits-only swarm",
      config: { tools: { swarm: { maxConcurrent: 2 } } },
      enabled: true,
    },
    { name: "boolean opt-in", config: { tools: { swarm: true } }, enabled: true },
    { name: "boolean opt-out", config: { tools: { swarm: false } }, enabled: false },
    {
      name: "object opt-out",
      config: { tools: { swarm: { enabled: false } } },
      enabled: false,
    },
    {
      name: "per-agent opt-out",
      config: { agents: { entries: { main: { tools: { swarm: false } } } } },
      enabled: false,
    },
    {
      name: "per-agent limits inherit global opt-out",
      config: {
        tools: { swarm: false },
        agents: { entries: { main: { tools: { swarm: { maxConcurrent: 2 } } } } },
      },
      enabled: false,
    },
    {
      name: "per-agent empty object inherits global opt-out",
      config: {
        tools: { swarm: { enabled: false } },
        agents: { entries: { main: { tools: { swarm: {} } } } },
      },
      enabled: false,
    },
    {
      name: "per-agent opt-in overrides global opt-out",
      config: {
        tools: { swarm: false },
        agents: { entries: { main: { tools: { swarm: true } } } },
      },
      enabled: true,
    },
    {
      name: "per-agent object opt-out overrides global opt-in",
      config: {
        tools: { swarm: true },
        agents: { entries: { main: { tools: { swarm: { enabled: false } } } } },
      },
      enabled: false,
    },
  ])("honors $name", ({ config, enabled }) => {
    expect(resolveSwarmConfig(config, "main").enabled).toBe(enabled);
  });
});
