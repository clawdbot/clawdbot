// QA Lab suite selection keeps scenario requirements on their declared provider lane.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { QaTransportAdapterFactory } from "./qa-transport-registry.js";
import { requireFlowScenario } from "./scenario-catalog.test-utils.js";
import { runQaSuite } from "./suite-launch.runtime.js";
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
      adapterFactories: [
        {
          id: "matrix",
          supportsModuleFlows: true,
          matches: ({ driver, channelId }) => driver === "live" && channelId === "matrix",
          create: async () => {
            throw new Error("Matrix adapter creation must remain unreachable");
          },
        } satisfies QaTransportAdapterFactory,
      ],
    },
    { scenarioId: "goal-context-next-turn", adapterFactories: undefined },
    { scenarioId: "subagent-completion-direct-fallback", adapterFactories: undefined },
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
          adapterFactories: selection.adapterFactories,
          startLab,
        }),
      ).rejects.toThrow("selected provider lane reached lab startup");
      expect(startLab).toHaveBeenCalledOnce();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("adopts a single runtime-partitioned flow scenario's required provider", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-suite-unified-provider-"));
    const startLab = vi.fn(async () => {
      throw new Error("selected unified provider lane reached lab startup");
    });

    try {
      const result = await runQaSuite({
        repoRoot,
        scenarioIds: ["long-context-progress-watchdog"],
        startLab,
      });

      expect(result.executionKind).toBe("suite");
      expect(startLab).toHaveBeenCalledOnce();
      expect(result.result.scenarios).toEqual([
        expect.objectContaining({
          status: "fail",
          details: expect.stringContaining("selected unified provider lane reached lab startup"),
        }),
      ]);
      const summary = JSON.parse(await readFile(result.result.summaryPath, "utf8")) as {
        run: { providerMode: string; primaryModel: string; alternateModel: string };
      };
      expect(summary.run).toMatchObject({
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6",
        alternateModel: "openai/gpt-5.6-luna",
      });
      expect(summary.run.primaryModel).not.toBe(summary.run.alternateModel);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps an explicit unified provider override ahead of a scenario requirement", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-suite-unified-override-"));
    const startLab = vi.fn();

    try {
      const result = await runQaSuite({
        repoRoot,
        providerMode: "mock-openai",
        scenarioIds: ["long-context-progress-watchdog"],
        startLab,
      });

      expect(result.executionKind).toBe("suite");
      expect(startLab).not.toHaveBeenCalled();
      expect(result.result.scenarios).toEqual([
        expect.objectContaining({
          status: "fail",
          details: expect.stringContaining("providerMode=live-frontier"),
        }),
      ]);
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
