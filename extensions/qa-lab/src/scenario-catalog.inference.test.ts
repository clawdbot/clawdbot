import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readQaScenarioById, readQaScenarioExecutionConfig } from "./scenario-catalog.js";
import { requireFlowScenario } from "./scenario-catalog.test-utils.js";

describe("QA inference scenario catalog", () => {
  it("isolates live goal followthrough from shared gateway state", () => {
    const scenario = requireFlowScenario(readQaScenarioById("goal-followthrough-live"));

    expect(scenario.execution).toMatchObject({
      suiteIsolation: "isolated",
      isolationReason: expect.stringContaining("active goal"),
      retryCount: 0,
      config: {
        requiredProviderMode: "live-frontier",
        readyMarker: "GOAL-CONTINUANCE-READY",
        doneMarker: "GOAL-CONTINUANCE-DONE",
      },
    });
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "starts the staged goal without completing its objective",
      "verifies the durable goal stays active before continuation",
      "advances the active goal on bare continue",
    ]);
  });

  it("runs the long-context watchdog through the declared Codex runtime", () => {
    const scenario = readQaScenarioById("long-context-progress-watchdog");

    expect(scenario.execution).toMatchObject({ kind: "flow", runtime: "codex" });
    expect(readQaScenarioExecutionConfig(scenario.id)).toMatchObject({
      requiredProviderMode: "live-frontier",
      harnessRuntime: "codex",
      fixtureFile: "LONG_CONTEXT_SENTINEL_FIXTURE.txt",
      expectedMarker: "LONG-CONTEXT-WATCHDOG-OK",
      repeatCount: 2000,
    });
    expect(scenario.plugins).toBeUndefined();
    expect(scenario.gatewayConfigPatch).toBeUndefined();
  });

  it("preserves the mock-only retry-exhaustion scenario contract", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("empty-response-retry-budget-exhausted"),
    );

    expect(scenario.execution.config).toMatchObject({
      requiredProvider: "mock-openai",
      retryNeedle: "The previous attempt did not produce a user-visible answer.",
      settledToolRetryNeedle:
        "The previous assistant turn completed its tool calls but did not produce a user-visible answer.",
      expectedDiagnostic: "⚠️ Agent couldn't generate a response. Please try again.",
      unexpectedSuccessMarker: "EMPTY-EXHAUSTED-OK",
    });
    expect(scenario.execution.flow?.steps).toHaveLength(1);
  });

  it("keeps worker inference provider stages on one admitted generation", () => {
    const scenario = readQaScenarioById("worker-inference-generation-reload");
    const scriptPath = path.join(
      import.meta.dirname,
      "../../../test/e2e/qa-lab/runtime/worker-inference-generation-reload.ts",
    );
    const fixturePath = path.join(
      import.meta.dirname,
      "../../../test/e2e/qa-lab/runtime/fixtures/worker-inference-generation-provider/index.js",
    );
    const script = fs.readFileSync(scriptPath, "utf8");
    const fixture = fs.readFileSync(fixturePath, "utf8");

    expect(scenario.execution).toMatchObject({
      kind: "script",
      path: "test/e2e/qa-lab/runtime/worker-inference-generation-reload.ts",
      timeoutMs: 900_000,
    });
    expect(scenario.successCriteria).toContain(
      "Releasing B overrides the placement's stale A lifecycle scope and constructs the provider factory, stream policy, wrapper, and stream execution entirely from generation B with B's prepared model and runtime credential.",
    );
    expect(script).toContain("createPairedNodeWorkerHost");
    expect(script).toContain("startQaMockOpenAiServer");
    expect(script).toContain(
      'const OWNERSHIP_STAGES = ["factory", "policy", "wrapper", "execution"]',
    );
    expect(script).toContain("hotPublishGeneration");
    expect(script).toContain("startAuthInspectingProxy");
    expect(script).toContain("runtimeCredentialGenerations");
    expect(script).toContain("replyCounts[reply] !== 1");
    expect(script).not.toContain("createWorkerInferenceExecutor");
    expect(fixture).toContain('from "openclaw/plugin-sdk/llm"');
    expect(fixture).toContain("prepareRuntimeAuth");
    expect(fixture).toContain("createStreamFn");
    expect(fixture).toContain("prepareExtraParams");
    expect(fixture).toContain("wrapStreamFn");
    expect(fixture).not.toContain("src/");
  });
});
