import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

function splitModelRef(ref: string) {
  const slash = ref.indexOf("/");
  return slash > 0 ? { provider: ref.slice(0, slash), model: ref.slice(slash + 1) } : null;
}

describe("live inbound voice talkback scenario", () => {
  it("rejects a live OpenAI model outside the scenario contract", async () => {
    await expect(
      runLoadedScenarioFlow("inbound-voice-talkback-live", {
        api: {
          env: {
            providerMode: "live-frontier",
            primaryModel: "openai/gpt-5.4-mini",
          },
          splitModelRef,
        },
      }),
    ).rejects.toThrow("expected live primary model gpt-5.4, got openai/gpt-5.4-mini");
  });

  it("reuses the spoken WAV fixture and ignores a deleted streaming preview", async () => {
    const state = createQaBusState();
    const expectedReply = "Matrix QA voice pre-flight OK.";

    const result = await runLoadedScenarioFlow("inbound-voice-talkback-live", {
      state,
      api: {
        env: {
          providerMode: "live-frontier",
          primaryModel: "openai/gpt-5.4",
          gateway: {
            runtimeEnv: {
              OPENAI_API_KEY: "test-openai-key",
            },
          },
        },
        splitModelRef,
        markGatewayLogCursor: () => 0,
        readGatewayLogs: () => "",
        resolveQaLiveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
      },
      onWaitForOutboundMessage: ({ state: currentState }) => {
        const preview = currentState.addOutboundMessage({
          accountId: "qa-channel",
          to: "dm:qa-live-voice-talkback",
          text: expectedReply,
        });
        currentState.deleteMessage({
          accountId: "qa-channel",
          messageId: preview.id,
        });
        currentState.addOutboundMessage({
          accountId: "qa-channel",
          to: "dm:qa-live-voice-talkback",
          text: expectedReply,
        });
      },
    });

    expect(result.status).toBe("pass");
    const inbound = state.getSnapshot().messages.find((message) => message.direction === "inbound");
    const audioBase64 = inbound?.attachments?.[0]?.contentBase64;
    expect(audioBase64).toBeTruthy();
    const audio = Buffer.from(audioBase64 ?? "", "base64");
    expect(audio.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(audio).toHaveLength(54_238);
    expect(createHash("sha256").update(audio).digest("hex")).toBe(
      "14f4c287682e7762cb17debd99b5126fcb43c875f8a225953ffc71295e6a71cb",
    );
    const outbound = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound");
    expect(outbound).toHaveLength(2);
    expect(outbound.map((message) => message.deleted === true)).toEqual([true, false]);
    expect(outbound.filter((message) => !message.deleted).map((message) => message.text)).toEqual([
      expectedReply,
    ]);
  });
});
