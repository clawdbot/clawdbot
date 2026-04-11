import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { qaSuiteTesting } from "./suite.js";

describe("qa suite failure reply handling", () => {
  const makeScenario = (
    id: string,
    config?: Record<string, unknown>,
  ): Parameters<typeof qaSuiteTesting.selectQaSuiteScenarios>[0]["scenarios"][number] =>
    ({
      id,
      title: id,
      surface: "test",
      objective: "test",
      successCriteria: ["test"],
      sourcePath: `qa/scenarios/${id}.md`,
      execution: {
        kind: "flow",
        config,
        flow: { steps: [{ name: "noop", actions: [{ assert: "true" }] }] },
      },
    }) as Parameters<typeof qaSuiteTesting.selectQaSuiteScenarios>[0]["scenarios"][number];

  it("normalizes suite concurrency to a bounded integer", () => {
    const previous = process.env.OPENCLAW_QA_SUITE_CONCURRENCY;
    delete process.env.OPENCLAW_QA_SUITE_CONCURRENCY;
    try {
      expect(qaSuiteTesting.normalizeQaSuiteConcurrency(undefined, 10)).toBe(10);
      expect(qaSuiteTesting.normalizeQaSuiteConcurrency(undefined, 80)).toBe(64);
      expect(qaSuiteTesting.normalizeQaSuiteConcurrency(2.8, 10)).toBe(2);
      expect(qaSuiteTesting.normalizeQaSuiteConcurrency(20, 3)).toBe(3);
      expect(qaSuiteTesting.normalizeQaSuiteConcurrency(0, 3)).toBe(1);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_QA_SUITE_CONCURRENCY;
      } else {
        process.env.OPENCLAW_QA_SUITE_CONCURRENCY = previous;
      }
    }
  });

  it("maps suite work with bounded concurrency while preserving order", async () => {
    let active = 0;
    let maxActive = 0;
    const result = await qaSuiteTesting.mapQaSuiteWithConcurrency([1, 2, 3, 4], 2, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return item * 10;
    });

    expect(maxActive).toBe(2);
    expect(result).toEqual([10, 20, 30, 40]);
  });

  it("keeps explicitly requested provider-specific scenarios", () => {
    const scenarios = [
      makeScenario("generic"),
      makeScenario("anthropic-only", {
        requiredProvider: "anthropic",
        requiredModel: "claude-opus-4-6",
      }),
    ];

    expect(
      qaSuiteTesting
        .selectQaSuiteScenarios({
          scenarios,
          scenarioIds: ["anthropic-only"],
          providerMode: "live-frontier",
          primaryModel: "openai/gpt-5.4",
        })
        .map((scenario) => scenario.id),
    ).toEqual(["anthropic-only"]);
  });

  it("filters provider-specific scenarios from an implicit live lane", () => {
    const scenarios = [
      makeScenario("generic"),
      makeScenario("openai-only", { requiredProvider: "openai", requiredModel: "gpt-5.4" }),
      makeScenario("anthropic-only", {
        requiredProvider: "anthropic",
        requiredModel: "claude-opus-4-6",
      }),
      makeScenario("claude-subscription", {
        requiredProvider: "claude-cli",
        authMode: "subscription",
      }),
    ];

    expect(
      qaSuiteTesting
        .selectQaSuiteScenarios({
          scenarios,
          providerMode: "live-frontier",
          primaryModel: "openai/gpt-5.4",
        })
        .map((scenario) => scenario.id),
    ).toEqual(["generic", "openai-only"]);

    expect(
      qaSuiteTesting
        .selectQaSuiteScenarios({
          scenarios,
          providerMode: "live-frontier",
          primaryModel: "claude-cli/claude-sonnet-4-6",
          claudeCliAuthMode: "subscription",
        })
        .map((scenario) => scenario.id),
    ).toEqual(["generic", "claude-subscription"]);
  });

  it("reads retry-after from the primary gateway error before appended logs", () => {
    const error = new Error(
      "rate limit exceeded for config.patch; retry after 38s\nGateway logs:\nprevious config changed since last load",
    );

    expect(qaSuiteTesting.getGatewayRetryAfterMs(error)).toBe(38_000);
    expect(qaSuiteTesting.isConfigHashConflict(error)).toBe(false);
  });

  it("ignores stale retry-after text that only appears in appended gateway logs", () => {
    const error = new Error(
      "config changed since last load; re-run config.get and retry\nGateway logs:\nold rate limit exceeded for config.patch; retry after 38s",
    );

    expect(qaSuiteTesting.getGatewayRetryAfterMs(error)).toBe(null);
    expect(qaSuiteTesting.isConfigHashConflict(error)).toBe(true);
  });

  it("detects classified failure replies before a success-only outbound predicate matches", async () => {
    const state = createQaBusState();
    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });

    const message = qaSuiteTesting.findFailureOutboundMessage(state);
    expect(message?.text).toContain("Something went wrong while processing your request.");
  });

  it("fails success-only waitForOutboundMessage calls when a classified failure reply arrives first", async () => {
    const state = createQaBusState();
    const pending = qaSuiteTesting.waitForOutboundMessage(
      state,
      (candidate) =>
        candidate.conversation.id === "qa-operator" &&
        candidate.text.includes("Remembered ALPHA-7."),
      5_000,
    );

    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: '⚠️ No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai-codex/gpt-5.4 (OAuth) or set OPENAI_API_KEY to use openai/gpt-5.4.',
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });

    await expect(pending).rejects.toThrow('No API key found for provider "openai".');
  });

  it("treats QA channel message delivery failures as failure replies", async () => {
    const state = createQaBusState();
    const pending = qaSuiteTesting.waitForOutboundMessage(
      state,
      (candidate) => candidate.text.includes("QA-RESTART"),
      5_000,
    );

    state.addOutboundMessage({
      to: "channel:qa-room",
      text: "⚠️ ✉️ Message failed",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });

    await expect(pending).rejects.toThrow("Message failed");
  });

  it("fails raw scenario waitForCondition calls when a classified failure reply arrives", async () => {
    const state = createQaBusState();
    const waitForCondition = qaSuiteTesting.createScenarioWaitForCondition(state);

    const pending = waitForCondition(
      () =>
        state
          .getSnapshot()
          .messages.findLast(
            (message) =>
              message.direction === "outbound" &&
              message.conversation.id === "qa-operator" &&
              message.text.includes("ALPHA-7"),
          ),
      5_000,
      10,
    );

    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: '⚠️ No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai-codex/gpt-5.4 (OAuth) or set OPENAI_API_KEY to use openai/gpt-5.4.',
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });

    await expect(pending).rejects.toThrow('No API key found for provider "openai".');
  });

  it("fails raw scenario waitForCondition calls even when mixed traffic already exists", async () => {
    const state = createQaBusState();
    state.addInboundMessage({
      conversation: { id: "qa-operator", kind: "direct" },
      senderId: "alice",
      senderName: "Alice",
      text: "hello",
    });
    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: "working on it",
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });
    state.addInboundMessage({
      conversation: { id: "qa-operator", kind: "direct" },
      senderId: "alice",
      senderName: "Alice",
      text: "ok do it",
    });

    const waitForCondition = qaSuiteTesting.createScenarioWaitForCondition(state);
    const pending = waitForCondition(
      () =>
        state
          .getSnapshot()
          .messages.slice(3)
          .findLast(
            (message) =>
              message.direction === "outbound" &&
              message.conversation.id === "qa-operator" &&
              message.text.includes("mission"),
          ),
      150,
      10,
    );

    state.addOutboundMessage({
      to: "dm:qa-operator",
      text: '⚠️ No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai-codex/gpt-5.4 (OAuth) or set OPENAI_API_KEY to use openai/gpt-5.4.',
      senderId: "openclaw",
      senderName: "OpenClaw QA",
    });

    await expect(pending).rejects.toThrow('No API key found for provider "openai".');
  });
});
