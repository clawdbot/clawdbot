import { completeSimple, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createSingleUserPromptMessage,
  extractNonEmptyAssistantText,
  isLiveTestEnabled,
} from "./live-test-helpers.js";

const MINIMAX_KEY = process.env.MINIMAX_API_KEY ?? "";
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL?.trim() || "https://api.minimax.io/anthropic";
const MINIMAX_MODEL = process.env.MINIMAX_MODEL?.trim() || "MiniMax-M2.7";
const LIVE = isLiveTestEnabled(["MINIMAX_LIVE_TEST"]);

const describeLive = LIVE && MINIMAX_KEY ? describe : describe.skip;

async function runMinimaxTextProbe(model: Model<"anthropic-messages">, maxTokens: number) {
  const res = await completeSimple(
    model,
    {
      messages: createSingleUserPromptMessage(),
    },
    { apiKey: MINIMAX_KEY, maxTokens },
  );
  return {
    res,
    text: extractNonEmptyAssistantText(res.content),
  };
}

describeLive("minimax live", () => {
  it("returns assistant text", async () => {
    const model: Model<"anthropic-messages"> = {
      id: MINIMAX_MODEL,
      name: `MiniMax ${MINIMAX_MODEL}`,
      api: "anthropic-messages",
      provider: "minimax",
      baseUrl: MINIMAX_BASE_URL,
      reasoning: false,
      input: ["text"],
      // Pricing: placeholder values (per 1M tokens, multiplied by 1000 for display)
      cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
      contextWindow: 200000,
      maxTokens: 8192,
    };
    let { res, text } = await runMinimaxTextProbe(model, 128);
    // MiniMax can spend a small token budget in hidden thinking before it emits
    // the visible answer. Give this smoke probe one larger retry.
    if (text.length === 0 && res.stopReason === "length") {
      ({ text } = await runMinimaxTextProbe(model, 256));
    }
    expect(text.length).toBeGreaterThan(0);
  }, 20000);
});
