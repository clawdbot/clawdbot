import { describe, expect, it } from "vitest";
import { buildQaSuiteSummaryJson } from "./suite.js";

describe("buildQaSuiteSummaryJson", () => {
  const baseParams = {
    // Test scenarios include a `steps: []` field to match the real suite
    // scenario-result shape so downstream consumers that rely on the shape
    // (parity gate, report render) stay aligned.
    scenarios: [
      { name: "Scenario A", status: "pass" as const, steps: [] },
      { name: "Scenario B", status: "fail" as const, details: "something broke", steps: [] },
    ],
    startedAt: new Date("2026-04-11T00:00:00.000Z"),
    finishedAt: new Date("2026-04-11T00:05:00.000Z"),
    providerMode: "mock-openai" as const,
    primaryModel: "openai/gpt-5.5",
    alternateModel: "openai/gpt-5.5-alt",
    fastMode: true,
    concurrency: 2,
  };

  it("records provider/model/mode so parity gates can verify labels", () => {
    const json = buildQaSuiteSummaryJson(baseParams);
    expect(json.run.startedAt).toBe("2026-04-11T00:00:00.000Z");
    expect(json.run.finishedAt).toBe("2026-04-11T00:05:00.000Z");
    expect(json.run.providerMode).toBe("mock-openai");
    expect(json.run.primaryModel).toBe("openai/gpt-5.5");
    expect(json.run.primaryProvider).toBe("openai");
    expect(json.run.primaryModelName).toBe("gpt-5.5");
    expect(json.run.alternateModel).toBe("openai/gpt-5.5-alt");
    expect(json.run.alternateProvider).toBe("openai");
    expect(json.run.alternateModelName).toBe("gpt-5.5-alt");
    expect(json.run.fastMode).toBe(true);
    expect(json.run.concurrency).toBe(2);
    expect(json.run.scenarioIds).toBeNull();
  });

  it("includes scenarioIds in run metadata when provided", () => {
    const scenarioIds = ["approval-turn-tool-followthrough", "subagent-handoff", "memory-recall"];
    const json = buildQaSuiteSummaryJson({
      ...baseParams,
      scenarioIds,
    });
    expect(json.run.scenarioIds).toEqual(scenarioIds);
  });

  it("treats an empty scenarioIds array as unspecified (no filter)", () => {
    // A CLI path that omits --scenario passes an empty array to runQaSuite.
    // The summary must encode that as null so downstream parity/report
    // tooling doesn't interpret a full run as an explicit empty selection.
    const json = buildQaSuiteSummaryJson({
      ...baseParams,
      scenarioIds: [],
    });
    expect(json.run.scenarioIds).toBeNull();
  });

  it("records an Anthropic baseline lane cleanly for parity runs", () => {
    const json = buildQaSuiteSummaryJson({
      ...baseParams,
      primaryModel: "anthropic/claude-opus-4-6",
      alternateModel: "anthropic/claude-sonnet-4-6",
    });
    expect(json.run.primaryModel).toBe("anthropic/claude-opus-4-6");
    expect(json.run.primaryProvider).toBe("anthropic");
    expect(json.run.primaryModelName).toBe("claude-opus-4-6");
    expect(json.run.alternateModel).toBe("anthropic/claude-sonnet-4-6");
    expect(json.run.alternateProvider).toBe("anthropic");
    expect(json.run.alternateModelName).toBe("claude-sonnet-4-6");
  });

  it("leaves split fields null when a model ref is malformed", () => {
    const json = buildQaSuiteSummaryJson({
      ...baseParams,
      primaryModel: "not-a-real-ref",
      alternateModel: "",
    });
    expect(json.run.primaryModel).toBe("not-a-real-ref");
    expect(json.run.primaryProvider).toBeNull();
    expect(json.run.primaryModelName).toBeNull();
    expect(json.run.alternateModel).toBe("");
    expect(json.run.alternateProvider).toBeNull();
    expect(json.run.alternateModelName).toBeNull();
  });

  it("keeps scenarios and counts alongside the run metadata", () => {
    const json = buildQaSuiteSummaryJson(baseParams);
    expect(json.scenarios).toHaveLength(2);
    expect(json.counts).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
    });
  });

  it("records optional runtime metrics when provided", () => {
    const json = buildQaSuiteSummaryJson({
      ...baseParams,
      metrics: {
        wallMs: 12_000,
        gatewayProcessCpuMs: 3_400,
        gatewayCpuCoreRatio: 0.283,
        gatewayProcessRssStartBytes: 100_000_000,
        gatewayProcessRssEndBytes: 125_000_000,
        gatewayProcessRssDeltaBytes: 25_000_000,
      },
    });
    expect(json.metrics).toEqual({
      wallMs: 12_000,
      gatewayProcessCpuMs: 3_400,
      gatewayCpuCoreRatio: 0.283,
      gatewayProcessRssStartBytes: 100_000_000,
      gatewayProcessRssEndBytes: 125_000_000,
      gatewayProcessRssDeltaBytes: 25_000_000,
    });
  });
});
