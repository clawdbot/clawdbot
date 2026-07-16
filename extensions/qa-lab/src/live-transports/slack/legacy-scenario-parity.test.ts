import { describe, expect, it } from "vitest";
import { readQaScenarioPack } from "../../scenario-catalog.js";
import * as scenarioRuntime from "./scenario-runtime.js";

describe("legacy Slack scenario migration", () => {
  it("keeps every retired runner id as a Slack module scenario", () => {
    const scenarios = readQaScenarioPack().scenarios.filter(
      (scenario) =>
        scenario.execution.kind === "flow" &&
        scenario.execution.channel === "slack" &&
        JSON.stringify(scenario.execution.flow).includes(
          "./live-transports/slack/scenario-runtime.js",
        ),
    );
    expect(scenarios).toHaveLength(17);
    for (const scenario of scenarios) {
      expect(scenario.execution).toMatchObject({ kind: "flow", channel: "slack" });
      expect(JSON.stringify(scenario.execution.flow)).toContain(
        "./live-transports/slack/scenario-runtime.js",
      );
      const flowText = JSON.stringify(scenario.execution.flow);
      const callName = flowText.match(/scenarioModule\.([A-Za-z0-9]+)/u)?.[1];
      expect(typeof scenarioRuntime[callName as keyof typeof scenarioRuntime], scenario.id).toBe(
        "function",
      );
    }
  });
});
