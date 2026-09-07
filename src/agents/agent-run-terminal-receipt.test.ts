import { describe, expect, it } from "vitest";
import {
  formatAgentRunRouteChange,
  type AgentRunTerminalReceipt,
} from "./agent-run-terminal-receipt.js";
import { isProviderModelRerouted } from "./provider-model-route.js";

const visibleRerouteReceipt: AgentRunTerminalReceipt = {
  runId: "run-1",
  sessionId: "session-1",
  turnId: "turn-1",
  requested: { provider: "provider", model: "requested" },
  effective: { provider: "provider", model: "configured", responseModel: "actual" },
  successfulToolNames: [],
  rerouted: true,
  terminalDisposition: "visible",
};

describe("isProviderModelRerouted", () => {
  it("keeps an equivalent vendor wire id from producing a model-switch fact", () => {
    const requested = { provider: "arcee", model: "trinity-large-thinking" };
    const effective = {
      provider: "arcee",
      model: "arcee-ai/trinity-large-thinking",
      responseModel: "arcee-ai/trinity-large-thinking",
    };
    const rerouted = isProviderModelRerouted(requested, effective);
    expect(rerouted).toBe(false);
    expect(
      formatAgentRunRouteChange(
        { ...visibleRerouteReceipt, requested, effective, rerouted },
        "run-1",
      ),
    ).toBeUndefined();
  });

  it.each([
    {
      provider: "arcee",
      model: "arcee-ai/trinity-large-preview",
      responseModel: "arcee-ai/trinity-large-preview",
    },
    {
      provider: "openrouter",
      model: "arcee-ai/trinity-large-thinking",
      responseModel: "arcee-ai/trinity-large-thinking",
    },
    {
      provider: "arcee",
      model: "arcee-ai/trinity-large-thinking",
      responseModel: "arcee-ai/trinity-large-preview",
    },
  ])("retains a real change to $provider/$model with response $responseModel", (effective) => {
    expect(
      isProviderModelRerouted({ provider: "arcee", model: "trinity-large-thinking" }, effective),
    ).toBe(true);
  });
});

describe("formatAgentRunRouteChange", () => {
  it("uses the producer response model", () => {
    expect(formatAgentRunRouteChange(visibleRerouteReceipt, "run-1")).toBe(
      "Model route changed: provider/requested → provider/actual.",
    );
  });

  it.each([
    {
      name: "stale run",
      receipt: visibleRerouteReceipt,
      expectedRunId: "run-2",
    },
    {
      name: "unchanged route",
      receipt: { ...visibleRerouteReceipt, rerouted: false },
      expectedRunId: "run-1",
    },
    {
      name: "non-visible reply",
      receipt: { ...visibleRerouteReceipt, terminalDisposition: "not-visible" as const },
      expectedRunId: "run-1",
    },
  ])("omits a route fact for a $name", ({ receipt, expectedRunId }) => {
    expect(formatAgentRunRouteChange(receipt, expectedRunId)).toBeUndefined();
  });

  it("redacts and bounds route text", () => {
    const secret = `sk-${"s".repeat(96)}`;
    const routeChange = formatAgentRunRouteChange(
      {
        runId: "run-1",
        sessionId: "session-1",
        turnId: "turn-1",
        requested: { provider: "provider", model: secret },
        effective: {
          provider: "provider",
          model: "configured",
          responseModel: "m".repeat(500),
        },
        successfulToolNames: [],
        rerouted: true,
        terminalDisposition: "visible",
      },
      "run-1",
    );

    expect(routeChange).not.toContain(secret);
    expect(routeChange?.length).toBeLessThanOrEqual(320);
  });
});
