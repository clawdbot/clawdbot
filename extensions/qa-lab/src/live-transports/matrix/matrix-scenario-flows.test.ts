import { describe, expect, it } from "vitest";
import {
  readQaBootstrapScenarioCatalog,
  readQaScenarioById,
  readQaScenarioExecutionConfig,
} from "../../scenario-catalog.js";

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
    if (scenario.execution.kind !== "flow" || scenario.execution.channel !== "matrix") {
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

  it("prepares the shared canary only for canary-dependent scenarios", () => {
    const canaryScenarioIds = new Set([
      "matrix-reaction-not-a-reply",
      "matrix-reaction-notification",
      "matrix-reaction-redaction-observed",
      "matrix-reaction-threaded",
      "matrix-voice-preflight-mention",
    ]);
    for (const scenario of scenarios) {
      const config = scenario.execution.config ?? {};
      expect(config.matrixRequireCanary === true, scenario.id).toBe(
        canaryScenarioIds.has(scenario.id),
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

  it("loads the voice preflight provider and media overrides", () => {
    expect(readQaScenarioById("matrix-voice-preflight-mention").execution).toMatchObject({
      kind: "flow",
      providerMode: "mock-openai",
      retryCount: 0,
      timeoutMs: 90_000,
    });
    expect(readQaScenarioById("matrix-voice-preflight-mention").gatewayConfigPatch).toMatchObject({
      tools: {
        media: {
          audio: {
            echoTranscript: true,
            enabled: true,
            models: [{ model: "gpt-4o-transcribe", provider: "openai" }],
            prompt: "MATRIX_QA_VOICE_PREFLIGHT_TRIGGER",
          },
        },
      },
      messages: {
        groupChat: {
          mentionPatterns: ["matrix\\W+qa\\W+voice\\W+pre[ -]?flight\\W+ok(?:ay)?"],
        },
      },
    });
    expect(readQaScenarioExecutionConfig("matrix-voice-preflight-mention")).toMatchObject({
      matrixRequireCanary: true,
      matrixConfigOverrides: {
        audio: {
          echoTranscript: true,
          enabled: true,
          models: [{ model: "gpt-4o-transcribe", provider: "openai" }],
          prompt: "MATRIX_QA_VOICE_PREFLIGHT_TRIGGER",
        },
        groupMentionPatterns: ["matrix\\W+qa\\W+voice\\W+pre[ -]?flight\\W+ok(?:ay)?"],
      },
    });
  });
});
