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
    expect(json.run).toMatchObject({
      startedAt: "2026-04-11T00:00:00.000Z",
      finishedAt: "2026-04-11T00:05:00.000Z",
      providerMode: "mock-openai",
      primaryModel: "openai/gpt-5.5",
      primaryProvider: "openai",
      primaryModelName: "gpt-5.5",
      alternateModel: "openai/gpt-5.5-alt",
      alternateProvider: "openai",
      alternateModelName: "gpt-5.5-alt",
      fastMode: true,
      concurrency: 2,
      scenarioIds: null,
    });
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
    expect(json.run).toMatchObject({
      primaryModel: "anthropic/claude-opus-4-6",
      primaryProvider: "anthropic",
      primaryModelName: "claude-opus-4-6",
      alternateModel: "anthropic/claude-sonnet-4-6",
      alternateProvider: "anthropic",
      alternateModelName: "claude-sonnet-4-6",
    });
  });

  it("leaves split fields null when a model ref is malformed", () => {
    const json = buildQaSuiteSummaryJson({
      ...baseParams,
      primaryModel: "not-a-real-ref",
      alternateModel: "",
    });
    expect(json.run).toMatchObject({
      primaryModel: "not-a-real-ref",
      primaryProvider: null,
      primaryModelName: null,
      alternateModel: "",
      alternateProvider: null,
      alternateModelName: null,
    });
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
});
