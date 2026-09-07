import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { waitForOutboundMessage } from "./suite-runtime-transport.js";

async function runMemoryRecallScenario(recallReply?: string) {
  const state = createQaBusState();
  const outboundCursors: Array<number | undefined> = [];
  let turnCount = 0;

  const result = await runLoadedScenarioFlow("memory-recall", {
    state,
    api: {
      env: {
        providerMode: "mock-openai",
        gateway: { workspaceDir: "/qa-memory-recall" },
      },
      fs: { rm: async () => undefined },
      path,
      formatMemoryDreamingDay: () => "2026-08-05",
      normalizeLowercaseStringOrEmpty,
      runAgentPrompt: async (_env: unknown, params: { message: string }) => {
        turnCount += 1;
        state.addInboundMessage({
          accountId: "qa-channel",
          conversation: { id: "qa-operator", kind: "direct" },
          senderId: "qa-operator",
          text: params.message,
        });
        const text = turnCount === 1 ? "Remembered ALPHA-7." : recallReply;
        if (text !== undefined) {
          state.addOutboundMessage({
            accountId: "qa-channel",
            to: "dm:qa-operator",
            text,
          });
        }
      },
      waitForOutboundMessage: async (...args: Parameters<typeof waitForOutboundMessage>) => {
        const [transportState, predicate, , options] = args;
        outboundCursors.push(options?.sinceIndex);
        return await waitForOutboundMessage(transportState, predicate, 10, options);
      },
    },
  });

  return { outboundCursors, result, state };
}

describe("memory recall scenario outbound evidence", () => {
  it("rejects the earlier remember acknowledgement when recall produces no reply", async () => {
    await expect(runMemoryRecallScenario()).rejects.toThrow("timed out after 10ms");
  });

  it("measures the recall cursor in outbound messages despite mixed prior traffic", async () => {
    const { outboundCursors, result, state } = await runMemoryRecallScenario("ALPHA-7.");

    expect(result.status).toBe("pass");
    expect(result.steps[1]?.details).toBe("ALPHA-7.");
    expect(state.getSnapshot().messages.map((message) => message.direction)).toEqual([
      "inbound",
      "outbound",
      "inbound",
      "outbound",
    ]);
    expect(outboundCursors).toEqual([undefined, 1]);
  });
});
