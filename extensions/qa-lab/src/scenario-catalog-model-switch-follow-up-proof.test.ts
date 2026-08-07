import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

function splitModelRef(raw: string) {
  const [provider, ...model] = raw.split("/");
  return provider && model.length
    ? { provider: provider.toLowerCase(), model: model.join("/") }
    : null;
}

function terminalReceipt(params: {
  runId: string;
  provider: string;
  model: string;
  responseModel?: string;
}) {
  const responseModel = params.responseModel ?? params.model;
  return {
    runId: params.runId,
    sessionId: "session-model-switch",
    turnId: `turn-${params.runId}`,
    requested: { provider: params.provider, model: params.model },
    effective: { provider: params.provider, model: responseModel, responseModel },
    successfulToolNames: [],
    rerouted: responseModel !== params.model,
    terminalDisposition: "visible",
  };
}

async function runFollowUp(params?: {
  alternateModel?: string;
  alternateReceiptRunId?: string;
  deleteAlternateReply?: boolean;
  onRun?: () => void;
}) {
  const state = createQaBusState();
  let call = 0;
  const runAgentPrompt = vi.fn(
    async (_env: unknown, prompt: { provider?: string; model?: string; message: string }) => {
      params?.onRun?.();
      call += 1;
      const runId = `run-${call}`;
      const provider = prompt.provider ?? "openai";
      const model = prompt.model ?? "primary-model";
      const outbound = state.addOutboundMessage({
        accountId: "qa-channel",
        to: "dm:qa-operator",
        text: call === 1 ? "hello from the primary model" : "the model switch handoff completed",
      });
      if (call === 2 && params?.deleteAlternateReply) {
        state.deleteMessage({ accountId: "qa-channel", messageId: outbound.id });
      }
      return {
        started: { runId },
        waited: {
          status: "ok",
          terminalReceipt: terminalReceipt({
            runId: call === 2 ? (params?.alternateReceiptRunId ?? runId) : runId,
            provider,
            model,
          }),
        },
      };
    },
  );
  const result = await runLoadedScenarioFlow("model-switch-follow-up", {
    state,
    api: {
      env: {
        providerMode: "mock-openai",
        primaryModel: "openai/primary-model",
        alternateModel: params?.alternateModel ?? "openai/alternate-model",
        gateway: {},
      },
      runAgentPrompt,
      splitModelRef,
      normalizeModelRef: splitModelRef,
      normalizeLowercaseStringOrEmpty: (value: unknown) =>
        typeof value === "string" ? value.trim().toLowerCase() : "",
      resolveQaLiveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
    },
  });
  return { result, runAgentPrompt };
}

describe("model-switch follow-up terminal evidence", () => {
  it("records exact receipts for both visible model runs", async () => {
    const { result } = await runFollowUp();

    expect(result.status).toBe("pass");
    expect(result.modelSwitchEvidence).toMatchObject({
      primary: { runId: "run-1", effective: { responseModel: "primary-model" } },
      alternate: { runId: "run-2", effective: { responseModel: "alternate-model" } },
    });
  });

  it("rejects a delayed prior-run receipt", async () => {
    await expect(runFollowUp({ alternateReceiptRunId: "run-1" })).rejects.toThrow(
      "alternate-model run did not return distinct exact owned model evidence",
    );
  });

  it("rejects normalized-identical refs before starting an agent run", async () => {
    const onRun = vi.fn();
    await expect(runFollowUp({ alternateModel: "OPENAI/primary-model", onRun })).rejects.toThrow(
      "primary and alternate models must normalize to different refs",
    );
    expect(onRun).not.toHaveBeenCalled();
  });

  it("rejects a deleted alternate reply", async () => {
    await expect(runFollowUp({ deleteAlternateReply: true })).rejects.toThrow(
      "test condition was not met",
    );
  });
});
