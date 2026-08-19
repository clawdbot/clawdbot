import { join } from "node:path";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { selectQaFlowSuiteScenarios } from "./suite-planning.js";
import { waitForOutboundMessage } from "./suite-runtime-transport.js";

const characterScenarioIds = ["character-vibes-gollum", "character-vibes-c3po"] as const;
const classifiedFailureReplies = [
  {
    failureName: "provider failure",
    failureText: '⚠️ No API key found for provider "openai".',
    isError: true,
  },
  {
    failureName: "delivery failure",
    failureText: "⚠️ ✉️ Message failed",
    isError: true,
  },
  {
    failureName: "missing tool failure",
    failureText: "Read: AGENT.md\nEvidence snippet: Tool read not found\nStatus: blocked",
    isError: false,
  },
  {
    failureName: "internal coordination leak",
    failureText: "checking thread context; then post a tight progress reply here.",
    isError: false,
  },
] as const;

function createCharacterScenarioApi(
  onWaitForOutboundMessage?: (state: ReturnType<typeof createQaBusState>) => void,
) {
  return {
    env: {
      providerMode: "live-frontier",
      gateway: {
        workspaceDir: "/qa-character-workspace",
      },
    },
    fs: {
      writeFile: async () => undefined,
    },
    path: { join },
    normalizeLowercaseStringOrEmpty,
    resolveQaLiveTurnTimeoutMs: () => 10,
    waitForOutboundMessage: async (
      state: ReturnType<typeof createQaBusState>,
      predicate: Parameters<typeof waitForOutboundMessage>[1],
      timeoutMs: number,
      options?: Parameters<typeof waitForOutboundMessage>[3],
    ) => {
      onWaitForOutboundMessage?.(state);
      return await waitForOutboundMessage(state, predicate, timeoutMs, options);
    },
    formatConversationTranscript: (state: ReturnType<typeof createQaBusState>) =>
      state
        .getSnapshot()
        .messages.map((message) => `${message.direction}:${message.text}`)
        .join("\n"),
  };
}

describe("character scenario transcript safety", () => {
  it.each(characterScenarioIds)("requires a live provider for %s", (scenarioId) => {
    const scenario = readQaScenarioById(scenarioId);

    expect(scenario.execution.config?.requiredProviderMode).toBe("live-frontier");
    expect(() =>
      selectQaFlowSuiteScenarios({
        scenarios: [scenario],
        scenarioIds: [scenarioId],
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
      }),
    ).toThrow(`${scenarioId} (providerMode=live-frontier)`);
    expect(
      selectQaFlowSuiteScenarios({
        scenarios: [scenario],
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
      }),
    ).toEqual([]);
    expect(
      selectQaFlowSuiteScenarios({
        scenarios: [scenario],
        scenarioIds: [scenarioId],
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
      }),
    ).toEqual([scenario]);
  });

  it.each(characterScenarioIds)("rejects forbidden model internals in %s", async (scenarioId) => {
    const state = createQaBusState();

    await expect(
      runLoadedScenarioFlow(scenarioId, {
        state,
        api: createCharacterScenarioApi((currentState) => {
          currentState.addOutboundMessage({
            accountId: "qa-channel",
            to: "dm:alice",
            text: "As an AI, I cannot stay in character.",
          });
        }),
      }),
    ).rejects.toThrow("hit fallback/error text: As an AI, I cannot stay in character.");

    expect(state.getSnapshot().messages.some((message) => message.direction === "outbound")).toBe(
      true,
    );
  });

  it.each(
    characterScenarioIds.flatMap((scenarioId) =>
      classifiedFailureReplies.map(({ failureName, failureText, isError }) => ({
        scenarioId,
        failureName,
        failureText,
        isError,
      })),
    ),
  )(
    "rejects a $failureName after an actual reply in $scenarioId",
    async ({ scenarioId, failureText, isError }) => {
      const state = createQaBusState();
      const firstReply = "The build is green, and I am here.";
      let waitCount = 0;

      await expect(
        runLoadedScenarioFlow(scenarioId, {
          state,
          api: createCharacterScenarioApi((currentState) => {
            currentState.addOutboundMessage({
              accountId: "qa-channel",
              to: "dm:alice",
              text: waitCount++ === 0 ? firstReply : failureText,
              ...(waitCount > 1 && isError ? { isError: true } : {}),
            });
          }),
        }),
      ).rejects.toThrow(failureText);

      expect(
        state
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound")
          .map((message) => message.text),
      ).toEqual([firstReply, failureText]);
    },
  );

  it.each(characterScenarioIds)(
    "rejects an entirely unanswered character conversation in %s",
    async (scenarioId) => {
      const state = createQaBusState();

      await expect(
        runLoadedScenarioFlow(scenarioId, {
          state,
          api: createCharacterScenarioApi(),
        }),
      ).rejects.toThrow("no assistant replies");

      expect(state.getSnapshot().messages).toHaveLength(4);
      expect(state.getSnapshot().messages.every((message) => message.direction === "inbound")).toBe(
        true,
      );
    },
  );

  it.each(characterScenarioIds)(
    "keeps partially missing replies visible without aborting %s",
    async (scenarioId) => {
      const state = createQaBusState();
      const reply = "The build is green, and I am here.";
      const result = await runLoadedScenarioFlow(scenarioId, {
        state,
        api: createCharacterScenarioApi((currentState) => {
          if (
            currentState.getSnapshot().messages.some((message) => message.direction === "outbound")
          ) {
            return;
          }
          currentState.addOutboundMessage({
            accountId: "qa-channel",
            to: "dm:alice",
            text: reply,
          });
        }),
      });

      expect(result.status).toBe("pass");
      expect(result.steps[0]?.details).toContain("inbound:");
      expect(result.steps[0]?.details).toContain(`outbound:${reply}`);
      const messages = state.getSnapshot().messages;
      expect(messages.filter((message) => message.direction === "inbound")).toHaveLength(4);
      expect(messages.filter((message) => message.direction === "outbound")).toHaveLength(1);
    },
  );
});
