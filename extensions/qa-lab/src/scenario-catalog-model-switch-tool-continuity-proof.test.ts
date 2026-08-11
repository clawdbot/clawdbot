import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { hasModelSwitchContinuitySignal } from "./model-switch-eval.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

function splitModelRef(raw: string) {
  const [provider, ...model] = raw.split("/");
  return provider && model.length
    ? { provider: provider.toLowerCase(), model: model.join("/") }
    : null;
}

function normalizeModelRef(raw: string) {
  const split = splitModelRef(raw);
  if (!split) {
    return null;
  }
  return split.provider === "openai" && split.model.toLowerCase() === "alternate-alias"
    ? { provider: "openai", model: "alternate-model" }
    : split;
}

async function runToolContinuity(
  alternateTools: string[],
  params?: {
    alternateWireToolName?: "read" | "exec";
    primaryOutboundText?: string;
    primaryDelivery?: { status: string; resultCount: number } | null;
    alternateReplyText?: string;
    alternateOutboundText?: string;
    alternateDelivery?: { status: string; resultCount: number } | null;
    unrelatedPrimaryOutboundText?: string;
    unrelatedLaterOutboundText?: string;
  },
) {
  const state = createQaBusState();
  let call = 0;
  const requests: Array<{
    cursor: number;
    allInputText: string;
    plannedToolName: string;
    plannedWireToolName: string;
  }> = [];
  const runAgentPrompt = vi.fn(
    async (_env: unknown, prompt: { provider?: string; model?: string; message: string }) => {
      call += 1;
      const runId = `run-${call}`;
      const provider = prompt.provider ?? "openai";
      const model = prompt.model ?? "primary-model";
      const replyText =
        call === 1
          ? "the QA scenario pack verifies source and docs"
          : (params?.alternateReplyText ??
            "the model handoff preserved the QA mission after rereading the scenario pack");
      state.addOutboundMessage({
        accountId: "qa-channel",
        to: "dm:qa-operator",
        text:
          call === 1
            ? (params?.primaryOutboundText ?? replyText)
            : (params?.alternateOutboundText ?? replyText),
      });
      if (call === 1 && params?.unrelatedPrimaryOutboundText) {
        state.addOutboundMessage({
          accountId: "qa-channel",
          to: "dm:qa-operator",
          text: params.unrelatedPrimaryOutboundText,
        });
      }
      if (call === 2 && params?.unrelatedLaterOutboundText) {
        state.addOutboundMessage({
          accountId: "qa-channel",
          to: "dm:qa-operator",
          text: params.unrelatedLaterOutboundText,
        });
      }
      const terminalDelivery = call === 1 ? params?.primaryDelivery : params?.alternateDelivery;
      const wireToolName = call === 1 ? "read" : (params?.alternateWireToolName ?? "read");
      requests.push({
        cursor: call,
        allInputText: prompt.message,
        plannedToolName: "read",
        plannedWireToolName: wireToolName,
      });
      return {
        started: { runId },
        waited: {
          status: "ok",
          ...(terminalDelivery === null
            ? {}
            : {
                terminalDelivery: terminalDelivery ?? { status: "sent", resultCount: 1 },
              }),
          terminalReply: { disposition: "visible", text: replyText },
          terminalReceipt: {
            runId,
            sessionId: "session-tools",
            turnId: `turn-${call}`,
            requested: { provider, model },
            effective: { provider, model, responseModel: model },
            successfulToolNames: call === 1 ? [wireToolName] : alternateTools,
            rerouted: false,
            terminalDisposition: "visible",
          },
        },
      };
    },
  );
  const result = await runLoadedScenarioFlow("model-switch-tool-continuity", {
    state,
    api: {
      env: {
        providerMode: "mock-openai",
        primaryModel: "openai/primary-model",
        alternateModel: "OPENAI/alternate-alias",
        mock: { baseUrl: "http://mock.test" },
        gateway: {},
      },
      fetchJson: async (url: string) =>
        url.includes("request-cursor")
          ? { cursor: call }
          : requests.filter(
              (request) => request.cursor > Number(url.match(/after=(\d+)/)?.[1] ?? -1),
            ),
      splitModelRef,
      normalizeModelRef,
      normalizeLowercaseStringOrEmpty: (value: unknown) =>
        typeof value === "string" ? value.trim().toLowerCase() : "",
      resolveQaLiveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
      hasModelSwitchContinuitySignal,
      runAgentPrompt,
    },
  });
  return { result, runAgentPrompt };
}

describe("model-switch tool continuity terminal evidence", () => {
  it("invokes the canonical alias target and accepts run-owned delivery", async () => {
    const { result, runAgentPrompt } = await runToolContinuity(["read"], {
      alternateReplyText:
        "the **model handoff** preserved the QA mission after rereading the scenario pack",
      alternateOutboundText:
        "the model handoff preserved the QA mission after rereading the scenario pack",
    });

    expect(result.status).toBe("pass");
    expect(runAgentPrompt.mock.calls[1]?.[1]).toMatchObject({
      provider: "openai",
      model: "alternate-model",
    });
    expect(result.modelSwitchEvidence).toMatchObject({
      primary: { runId: "run-1", successfulToolNames: ["read"] },
      alternate: { runId: "run-2", successfulToolNames: ["read"] },
      terminalReply: {
        disposition: "visible",
        text: "the **model handoff** preserved the QA mission after rereading the scenario pack",
      },
      terminalDelivery: { status: "sent", resultCount: 1 },
      alternateTool: { logical: "read", wire: "read" },
    });
    expect(result.steps[0]?.details).toBe(
      "the **model handoff** preserved the QA mission after rereading the scenario pack",
    );
  });

  it("accepts Code Mode exec receipts for logically planned reads", async () => {
    const { result } = await runToolContinuity(["exec"], {
      alternateWireToolName: "exec",
    });

    expect(result.status).toBe("pass");
    expect(result.modelSwitchEvidence).toMatchObject({
      primary: { successfulToolNames: ["read"] },
      alternate: { successfulToolNames: ["exec"] },
      alternateTool: { logical: "read", wire: "exec" },
    });
  });

  it("does not let a successful prior-run read satisfy the alternate run", async () => {
    await expect(runToolContinuity([])).rejects.toThrow(
      "alternate-model run did not return exact owned successful read evidence",
    );
  });

  it("rejects unrelated later continuity text when the alternate reply lacks it", async () => {
    await expect(
      runToolContinuity(["read"], {
        alternateReplyText: "the alternate tool run completed",
        unrelatedLaterOutboundText:
          "the model handoff preserved the QA mission after rereading the scenario pack",
      }),
    ).rejects.toThrow("alternate-model terminal reply missed kickoff continuity");
  });

  it.each([
    ["missing", null],
    ["suppressed", { status: "suppressed", resultCount: 0 }],
    ["zero-count", { status: "sent", resultCount: 0 }],
  ] as const)(
    "rejects %s primary delivery evidence despite identical and unrelated bus messages",
    async (_, evidence) => {
      await expect(
        runToolContinuity(["read"], {
          primaryDelivery: evidence,
          primaryOutboundText: "the QA scenario pack verifies source and docs",
          unrelatedPrimaryOutboundText: "an unrelated tool run also replied",
        }),
      ).rejects.toThrow("default-model run did not return owned sent delivery evidence");
    },
  );

  it.each([
    ["missing", null],
    ["suppressed", { status: "suppressed", resultCount: 0 }],
    ["zero-count", { status: "sent", resultCount: 0 }],
  ] as const)(
    "rejects %s delivery evidence despite an identical bus message",
    async (_, evidence) => {
      await expect(
        runToolContinuity(["read"], {
          alternateDelivery: evidence,
          alternateOutboundText:
            "the model handoff preserved the QA mission after rereading the scenario pack",
        }),
      ).rejects.toThrow("alternate-model run did not return owned sent delivery evidence");
    },
  );
});
