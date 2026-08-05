// QA Lab suite selection keeps scenario requirements on their declared provider lane.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requireFlowScenario } from "./scenario-catalog.test-utils.js";
import { selectQaFlowSuiteScenarios } from "./suite-planning.js";
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

describe("qa suite provider selection", () => {
  it("rejects an explicitly requested scenario for the wrong provider", () => {
    const scenarios = [
      makeQaSuiteTestScenario("generic"),
      makeQaSuiteTestScenario("anthropic-only", {
        config: {
          requiredProvider: "anthropic",
        },
      }),
    ];

    expect(() =>
      selectQaFlowSuiteScenarios({
        scenarios,
        scenarioIds: ["anthropic-only"],
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
      }),
    ).toThrow(
      "selected QA scenario(s) do not match the current QA lane: anthropic-only (provider=anthropic)",
    );
  });

  it("rejects an explicitly requested scenario for the wrong provider mode", () => {
    const scenarios = [
      makeQaSuiteTestScenario("mock-only", {
        config: { requiredProviderMode: "mock-openai" },
      }),
    ];

    expect(() =>
      selectQaFlowSuiteScenarios({
        scenarios,
        scenarioIds: ["mock-only"],
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
      }),
    ).toThrow(
      "selected QA scenario(s) do not match the current QA lane: mock-only (providerMode=mock-openai)",
    );
  });

  it("rejects an explicitly selected scenario whose provider pin conflicts with the requested lane", () => {
    const scenario = requireFlowScenario(
      makeQaSuiteTestScenario("mock-selected", { channel: "matrix" }),
    );
    scenario.execution.providerMode = "mock-openai";

    expect(() =>
      selectQaFlowSuiteScenarios({
        scenarios: [scenario],
        scenarioIds: [scenario.id],
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
        channelDriver: "live",
        channel: "matrix",
      }),
    ).toThrow(
      "selected QA scenario(s) do not match the current QA lane: mock-selected (providerMode=mock-openai)",
    );
  });

  it.each([
    {
      scenarioId: "matrix-room-block-streaming",
      channelDriver: "live" as const,
      channelId: "matrix",
    },
    { scenarioId: "goal-context-next-turn" },
  ])("adopts the provider requirement for directly selected $scenarioId", async (selection) => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-suite-provider-lane-"));
    const startLab = vi.fn(async () => {
      throw new Error("selected provider lane reached lab startup");
    });

    try {
      await expect(
        runQaFlowSuiteFromRuntime({
          repoRoot,
          scenarioIds: [selection.scenarioId],
          ...("channelDriver" in selection
            ? { channelDriver: selection.channelDriver, channelId: selection.channelId }
            : {}),
          startLab,
        }),
      ).rejects.toThrow("selected provider lane reached lab startup");
      expect(startLab).toHaveBeenCalledOnce();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects an explicit provider override that conflicts with a config-only scenario pin", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-suite-explicit-provider-"));
    const startLab = vi.fn();

    try {
      await expect(
        runQaFlowSuiteFromRuntime({
          repoRoot,
          scenarioIds: ["goal-context-next-turn"],
          providerMode: "live-frontier",
          startLab,
        }),
      ).rejects.toThrow("goal-context-next-turn (providerMode=mock-openai)");
      expect(startLab).not.toHaveBeenCalled();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
