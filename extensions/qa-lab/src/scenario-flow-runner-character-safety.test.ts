import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { waitForOutboundMessage } from "./suite-runtime-transport.js";

const characterScenarioIds = ["character-vibes-gollum", "character-vibes-c3po"] as const;

function createCharacterScenarioApi(
  onWaitForOutboundMessage?: (state: ReturnType<typeof createQaBusState>) => void,
) {
  return {
    env: {
      providerMode: "mock-openai",
      gateway: {
        workspaceDir: "/qa-character-workspace",
      },
    },
    fs: {
      writeFile: async () => undefined,
    },
    path: { join },
    normalizeLowercaseStringOrEmpty: (value: unknown) =>
      typeof value === "string" ? value.trim().toLowerCase() : "",
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
