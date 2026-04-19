import { describe, expect, it } from "vitest";
import {
  createChatEvent,
  createPendingPromptHarness,
  DEFAULT_SESSION_KEY,
} from "./translator.prompt-harness.test-support.js";

describe("acp translator errorKind mapping", () => {
  it("maps errorKind: refusal to stopReason: refusal", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: DEFAULT_SESSION_KEY,
        seq: 1,
        state: "error",
        errorKind: "refusal",
        errorMessage: "I cannot fulfill this request.",
      }),
    );

    await expect(promptPromise).resolves.toEqual({ stopReason: "refusal" });
  });

  it("maps errorKind: timeout to stopReason: end_turn", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: DEFAULT_SESSION_KEY,
        seq: 1,
        state: "error",
        errorKind: "timeout",
        errorMessage: "gateway timeout",
      }),
    );

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("maps unknown errorKind to stopReason: end_turn", async () => {
    const { agent, promptPromise, runId } = await createPendingPromptHarness();

    await agent.handleGatewayEvent(
      createChatEvent({
        runId,
        sessionKey: DEFAULT_SESSION_KEY,
        seq: 1,
        state: "error",
        errorKind: "unknown",
        errorMessage: "something went wrong",
      }),
    );

    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  });
});
