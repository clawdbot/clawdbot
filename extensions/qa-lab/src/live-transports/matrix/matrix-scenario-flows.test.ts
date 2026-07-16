import { describe, expect, it } from "vitest";
import { readQaBootstrapScenarioCatalog } from "../../scenario-catalog.js";

function readModuleBinding(
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number],
) {
  if (scenario.execution.kind !== "flow") {
    throw new Error(`expected Matrix module flow: ${scenario.id}`);
  }
  const actions = scenario.execution.flow?.steps.flatMap((step) => step.actions) ?? [];
  const importAction = actions.find(
    (action): action is { set: string; value: { expr: string } } =>
      typeof action === "object" &&
      action !== null &&
      "set" in action &&
      action.set === "scenarioModule" &&
      "value" in action &&
      typeof action.value === "object" &&
      action.value !== null &&
      "expr" in action.value &&
      typeof action.value.expr === "string" &&
      action.value.expr.includes("./live-transports/matrix/scenarios/scenario-runtime-"),
  );
  const callAction = actions.find(
    (action): action is { call: string; args?: unknown[] } =>
      typeof action === "object" &&
      action !== null &&
      "call" in action &&
      typeof action.call === "string" &&
      action.call.startsWith("scenarioModule."),
  );
  if (!importAction || !callAction) {
    throw new Error(`Matrix module flow is incomplete: ${scenario.id}`);
  }
  return { importAction, callAction };
}

describe("Matrix QA Lab scenario flows", () => {
  const catalog = readQaBootstrapScenarioCatalog();
  const scenarios = catalog.scenarios.filter((scenario) => {
    if (scenario.execution.kind !== "flow") {
      return false;
    }
    return scenario.execution.flow?.steps.some((step) =>
      step.actions.some(
        (action) =>
          typeof action === "object" &&
          action !== null &&
          "set" in action &&
          action.set === "scenarioModule",
      ),
    );
  });

  it("expands every Matrix module call through the shared flow host", () => {
    const bindings = new Set<string>();
    expect(scenarios).toHaveLength(82);
    for (const scenario of scenarios) {
      expect(scenario.execution.kind, scenario.id).toBe("flow");
      if (scenario.execution.kind !== "flow") {
        continue;
      }
      const { importAction, callAction } = readModuleBinding(scenario);
      bindings.add(`${importAction.value.expr}:${callAction.call}`);
      if (scenario.id !== "matrix-allowlist-hot-reload") {
        expect(scenario.objective, scenario.id).toBe(scenario.title);
        expect(scenario.successCriteria, scenario.id).toEqual([
          `${scenario.title} completes successfully.`,
        ]);
      }
      expect(scenario.execution.channel, scenario.id).toBe("matrix");
      expect(scenario.execution.retryCount, scenario.id).toBe(0);
      expect(scenario.execution.timeoutMs, scenario.id).toBeGreaterThan(0);
      expect(scenario.execution.flow?.steps.at(-1)?.detailsExpr, scenario.id).toBe(
        "result.details ?? (result.artifacts ? JSON.stringify(result.artifacts, null, 2) : undefined)",
      );
    }
    expect(bindings.size).toBe(82);
  });

  it("prepares the shared reaction canary only for reaction scenarios", () => {
    for (const scenario of scenarios) {
      const config = scenario.execution.config ?? {};
      expect(config.matrixRequireCanary === true, scenario.id).toBe(
        scenario.id.startsWith("matrix-reaction-"),
      );
      expect(readModuleBinding(scenario).callAction.args).toEqual([{ expr: "scenarioContext" }]);
    }
  });

  it("runs the allowlist scenario through its config-file reload owner", () => {
    const scenario = catalog.scenarios.find((entry) => entry.id === "matrix-allowlist-hot-reload");
    expect(scenario?.execution.kind).toBe("flow");
    if (scenario?.execution.kind !== "flow") {
      return;
    }
    const { importAction, callAction } = readModuleBinding(scenario);
    expect(importAction.value.expr).toContain("scenario-runtime-config.js");
    expect(callAction).toEqual({
      call: "scenarioModule.runMatrixQaAllowlistHotReloadScenario",
      args: [{ expr: "scenarioContext" }],
      saveAs: "result",
    });
  });
});
