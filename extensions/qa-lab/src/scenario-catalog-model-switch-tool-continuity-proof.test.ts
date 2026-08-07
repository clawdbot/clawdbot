import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { hasModelSwitchContinuitySignal } from "./model-switch-eval.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

function splitModelRef(raw: string) {
  const [provider, ...model] = raw.split("/");
  return provider && model.length
    ? { provider: provider.toLowerCase(), model: model.join("/") }
    : null;
}

async function runToolContinuity(alternateTools: string[]) {
  const state = createQaBusState();
  let call = 0;
  return await runLoadedScenarioFlow("model-switch-tool-continuity", {
    state,
    api: {
      env: {
        providerMode: "mock-openai",
        primaryModel: "openai/primary-model",
        alternateModel: "openai/alternate-model",
        gateway: {},
      },
      splitModelRef,
      normalizeModelRef: splitModelRef,
      normalizeLowercaseStringOrEmpty: (value: unknown) =>
        typeof value === "string" ? value.trim().toLowerCase() : "",
      resolveQaLiveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
      hasModelSwitchContinuitySignal,
      runAgentPrompt: async (_env: unknown, prompt: { provider?: string; model?: string }) => {
        call += 1;
        const runId = `run-${call}`;
        const provider = prompt.provider ?? "openai";
        const model = prompt.model ?? "primary-model";
        state.addOutboundMessage({
          accountId: "qa-channel",
          to: "dm:qa-operator",
          text:
            call === 1
              ? "the QA scenario pack verifies source and docs"
              : "the model handoff preserved the QA mission after rereading the scenario pack",
        });
        return {
          started: { runId },
          waited: {
            status: "ok",
            terminalReceipt: {
              runId,
              sessionId: "session-tools",
              turnId: `turn-${call}`,
              requested: { provider, model },
              effective: { provider, model, responseModel: model },
              successfulToolNames: call === 1 ? ["read"] : alternateTools,
              rerouted: false,
              terminalDisposition: "visible",
            },
          },
        };
      },
    },
  });
}

describe("model-switch tool continuity terminal evidence", () => {
  it("accepts a successful read owned by the alternate run", async () => {
    const result = await runToolContinuity(["read"]);

    expect(result.status).toBe("pass");
    expect(result.modelSwitchEvidence).toMatchObject({
      primary: { runId: "run-1", successfulToolNames: ["read"] },
      alternate: { runId: "run-2", successfulToolNames: ["read"] },
    });
  });

  it("does not let a successful prior-run read satisfy the alternate run", async () => {
    await expect(runToolContinuity([])).rejects.toThrow(
      "alternate-model run did not return exact owned successful read evidence",
    );
  });
});
