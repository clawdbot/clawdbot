import { describe, expect, it } from "vitest";
import { qaScenarioModuleFlow } from "./scenario-module-flow.js";

describe("QA scenario module flow", () => {
  it("resolves a module export argument against the loaded scenario module", () => {
    const flow = qaScenarioModuleFlow.moduleSchema.parse({
      module: "./scenario-runtime.js",
      call: "runScenario",
      args: [{ expr: "scenarioContext" }, { moduleExport: "scenarioImplementation" }],
    });

    expect(qaScenarioModuleFlow.resolveKind(flow)).toBe("module");
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

  it("distinguishes module syntax without relying on its source path", () => {
    const moduleFlow = qaScenarioModuleFlow.moduleSchema.parse({
      module: "example-package/scenario.js",
      call: "runScenario",
    });

    expect(qaScenarioModuleFlow.resolveKind(moduleFlow)).toBe("module");
    expect(qaScenarioModuleFlow.resolveKind({ steps: [] })).toBe("steps");
    expect(qaScenarioModuleFlow.resolveKind(undefined)).toBeUndefined();
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
