import { describe, expect, it } from "vitest";
import { readQaScenarioPack } from "../../scenario-catalog.js";
import * as scenarioRuntime from "./scenario-runtime.js";

describe("legacy WhatsApp scenario migration", () => {
  it("keeps every retired runner id as a WhatsApp module scenario", () => {
    const scenarios = readQaScenarioPack().scenarios.filter(
      (scenario) =>
        scenario.execution.kind === "flow" &&
        scenario.execution.channel === "whatsapp" &&
        JSON.stringify(scenario.execution.flow).includes(
          "./live-transports/whatsapp/scenario-runtime.js",
        ),
    );
    expect(scenarios).toHaveLength(38);
    for (const scenario of scenarios) {
      expect(scenario.execution).toMatchObject({ kind: "flow", channel: "whatsapp" });
      expect(JSON.stringify(scenario.execution.flow)).toContain(
        "./live-transports/whatsapp/scenario-runtime.js",
      );
      const flowText = JSON.stringify(scenario.execution.flow);
      const callName = flowText.match(/scenarioModule\.([A-Za-z0-9]+)/u)?.[1];
      expect(typeof scenarioRuntime[callName as keyof typeof scenarioRuntime], scenario.id).toBe(
        "function",
      );
    }
  });
});
