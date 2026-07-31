import { describe, expect, it } from "vitest";
import { qaScenarioModuleFlow } from "./scenario-module-flow.js";

describe("QA scenario module flow", () => {
  it("resolves a module export argument against the loaded scenario module", () => {
    const flow = qaScenarioModuleFlow.moduleSchema.parse({
      module: "./scenario-runtime.js",
      call: "runScenario",
      args: [{ expr: "scenarioContext" }, { moduleExport: "scenarioImplementation" }],
    });

    expect(qaScenarioModuleFlow.resolveFlow(flow, "Scenario title")).toMatchObject({
      steps: [
        {
          actions: [
            {
              set: "scenarioModule",
              value: { expr: 'await qaImport("./scenario-runtime.js")' },
            },
            {
              args: [
                { expr: "scenarioContext" },
                { expr: 'scenarioModule["scenarioImplementation"]' },
              ],
              call: "scenarioModule.runScenario",
            },
          ],
        },
      ],
    });
  });

  it("rejects malformed module export arguments", () => {
    expect(() =>
      qaScenarioModuleFlow.moduleSchema.parse({
        module: "./scenario-runtime.js",
        call: "runScenario",
        args: [{ moduleExport: "" }],
      }),
    ).toThrow("moduleExport arguments require a non-empty string export name");
  });
});
