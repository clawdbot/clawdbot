import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

type ProviderMode = "mock-openai" | "live-frontier";

async function runModelSwitchFollowUpScenario(params: {
  providerMode: ProviderMode;
  initialReply: string;
  followUpReply?: string;
}) {
  const state = createQaBusState();
  const requests: Array<{ allInputText: string; body: { model: string }; model: string }> = [];
  const primaryModel = "openai/primary-model";
  const alternateModel = "openai/alternate-model";
  const env = {
    providerMode: params.providerMode,
    primaryModel,
    alternateModel,
    ...(params.providerMode === "mock-openai" ? { mock: { baseUrl: "http://mock.invalid" } } : {}),
  };

  const result = await runLoadedScenarioFlow("model-switch-follow-up", {
    state,
    api: {
      env,
      splitModelRef: (ref: string) => {
        const slash = ref.indexOf("/");
        return slash > 0 ? { provider: ref.slice(0, slash), model: ref.slice(slash + 1) } : null;
      },
      normalizeLowercaseStringOrEmpty: (value: unknown) =>
        typeof value === "string" ? value.trim().toLowerCase() : "",
      resolveQaLiveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
      fetchJson: async (rawUrl: string) => {
        const url = new URL(rawUrl);
        if (url.pathname === "/debug/last-request") {
          return requests.at(-1);
        }
        if (url.pathname === "/debug/request-cursor") {
          return { cursor: requests.length };
        }
        if (url.pathname === "/debug/requests") {
          return requests.slice(Number(url.searchParams.get("after") ?? "0"));
        }
        throw new Error(`unexpected mock provider endpoint: ${url.pathname}`);
      },
      runAgentPrompt: async (_env: unknown, prompt: { message: string; model?: string }) => {
        state.addInboundMessage({
          accountId: "qa-channel",
          conversation: { id: "qa-operator", kind: "direct" },
          senderId: "qa-operator",
          text: prompt.message,
        });
        const model = prompt.model ?? "primary-model";
        requests.push({ allInputText: prompt.message, body: { model }, model });

        const reply = requests.length === 1 ? params.initialReply : params.followUpReply;
        if (reply !== undefined) {
          state.addOutboundMessage({
            accountId: "qa-channel",
            to: "dm:qa-operator",
            text: reply,
          });
        }
      },
    },
  });

  return { requests, result, state };
}

describe("model-switch follow-up scenario outbound evidence", () => {
  it.each([
    ["mock-openai", "The requested handoff comes next."],
    ["mock-openai", "The requested model switch comes next."],
    ["live-frontier", "The requested handoff comes next."],
    ["live-frontier", "The requested model switch comes next."],
  ] as const)(
    "rejects a stale first-turn handoff signal when %s produces no follow-up reply",
    async (providerMode, initialReply) => {
      await expect(runModelSwitchFollowUpScenario({ providerMode, initialReply })).rejects.toThrow(
        "test condition was not met",
      );
    },
  );

  it.each(["mock-openai", "live-frontier"] as const)(
    "accepts a fresh alternate-model reply after mixed first-turn traffic (%s)",
    async (providerMode) => {
      const followUpReply = "The alternate-model handoff completed successfully.";
      const { requests, result, state } = await runModelSwitchFollowUpScenario({
        providerMode,
        initialReply: "The requested handoff comes next.",
        followUpReply,
      });

      expect(result.status).toBe("pass");
      expect(result.steps[1]?.details).toBe(followUpReply);
      expect(requests.map((request) => request.model)).toEqual([
        "primary-model",
        "alternate-model",
      ]);
      expect(state.getSnapshot().messages.map((message) => message.direction)).toEqual([
        "inbound",
        "outbound",
        "inbound",
        "outbound",
      ]);
    },
  );
});
