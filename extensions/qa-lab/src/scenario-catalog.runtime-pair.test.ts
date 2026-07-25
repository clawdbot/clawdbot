// Qa Lab tests cover canonical runtime-pair scenario membership metadata.
import { describe, expect, it } from "vitest";
import { resolveQaParityPackScenarioIds } from "./agentic-parity.js";
import {
  QA_RUNTIME_PAIR_LANES,
  readQaScenarioById,
  readQaScenarioExecutionConfig,
  readQaScenarioPack,
} from "./scenario-catalog.js";

describe("QA runtime-pair scenario catalog", () => {
  it("uses the canonical lanes with audited declaration counts", () => {
    expect(QA_RUNTIME_PAIR_LANES).toEqual(["core", "extended", "soak"]);

    const laneCounts = Object.fromEntries(
      QA_RUNTIME_PAIR_LANES.map((lane) => [
        lane,
        readQaScenarioPack().scenarios.filter((scenario) => scenario.runtimePairLane === lane)
          .length,
      ]),
    );
    expect(laneCounts).toEqual({ core: 39, extended: 8, soak: 2 });
  });

  it("declares every release agentic scenario in the core lane", () => {
    const scenarioIds = resolveQaParityPackScenarioIds({ parityPack: "agentic" });

    expect(scenarioIds).toHaveLength(12);
    expect(scenarioIds.map((scenarioId) => readQaScenarioById(scenarioId).runtimePairLane)).toEqual(
      scenarioIds.map(() => "core"),
    );
  });

  it("keeps runtime-pair membership independent from provider eligibility", () => {
    const liveRequiredScenarioIds = [
      "issue-109025-completion-policy-live",
      "issue-109025-sender-policy-live",
      "webchat-direct-reply-routing",
      "goal-followthrough-live",
      "plugin-hook-health-sentinel",
      "codex-legacy-read-tool-vocabulary",
      "gateway-restart-multi-live",
      "streaming-final-integrity",
      "cron-model-created-explicit-authority",
      "cron-model-created-one-shot-recurring",
    ];
    for (const scenarioId of liveRequiredScenarioIds) {
      expect(readQaScenarioById(scenarioId).runtimePairLane).toBe("core");
      expect(readQaScenarioExecutionConfig(scenarioId)).toMatchObject({
        requiredProviderMode: "live-frontier",
      });
    }

    expect(readQaScenarioById("gateway-restart-inflight-run").runtimePairLane).toBe("core");
    expect(readQaScenarioExecutionConfig("gateway-restart-inflight-run")).toMatchObject({
      requiredProviderMode: "mock-openai",
    });

    for (const scenarioId of [
      "hosted-image-generation-providers-live",
      "hosted-video-generation-providers-live",
      "plugin-manifest-contract-health",
      "long-context-progress-watchdog",
    ]) {
      expect(readQaScenarioById(scenarioId).runtimePairLane).toBeUndefined();
    }
    expect(
      readQaScenarioById("plugin-manifest-contract-health").runtimeParityUsage,
    ).toBeUndefined();
    expect(readQaScenarioExecutionConfig("long-context-progress-watchdog")).toMatchObject({
      requiredProviderMode: "live-frontier",
      harnessRuntime: "codex",
    });
  });
});
