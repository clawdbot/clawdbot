import { describe, expect, it } from "vitest";
import { resolveSwarmConfig } from "./swarm-config.js";

describe("resolveSwarmConfig", () => {
  it("defaults off with the frozen limits", () => {
    expect(resolveSwarmConfig()).toEqual({
      enabled: false,
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
          agents: { list: [{ id: "main", tools: { swarm: { maxConcurrent: 4 } } }] },
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

  it("normalizes boolean forms", () => {
    expect(resolveSwarmConfig({ tools: { swarm: true } }).enabled).toBe(true);
    expect(resolveSwarmConfig({ tools: { swarm: false } }).enabled).toBe(false);
  });
});
