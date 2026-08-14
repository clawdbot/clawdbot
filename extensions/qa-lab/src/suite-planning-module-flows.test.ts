// Qa Lab tests cover module-flow-aware suite selection.
import { describe, expect, it } from "vitest";
import { selectQaFlowSuiteScenarios } from "./suite-planning.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

describe("qa suite planning module flows", () => {
  it("filters implicit module flows and rejects unsupported explicit selection", () => {
    const scenarios = [
      makeQaSuiteTestScenario("portable", { channel: "matrix" }),
      makeQaSuiteTestScenario("module-backed", {
        channel: "matrix",
        flowKind: "module",
      }),
    ];
    const lane = {
      scenarios,
      providerMode: "mock-openai" as const,
      primaryModel: "mock-openai/gpt-5.6-luna",
      channelDriver: "live" as const,
      channel: "matrix",
    };

    expect(selectQaFlowSuiteScenarios(lane).map((scenario) => scenario.id)).toEqual(["portable"]);
    expect(
      selectQaFlowSuiteScenarios({
        ...lane,
        resolveModuleFlowSupport: () => true,
      }).map((scenario) => scenario.id),
    ).toEqual(["portable", "module-backed"]);
    expect(() => selectQaFlowSuiteScenarios({ ...lane, scenarioIds: ["module-backed"] })).toThrow(
      "selected QA scenario(s) do not match the current QA lane: module-backed (module flow unsupported by implementation=live:matrix)",
    );
  });
});
