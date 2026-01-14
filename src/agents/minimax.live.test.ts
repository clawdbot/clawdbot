import { completeSimple, type Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";

const MINIMAX_KEY = process.env.MINIMAX_API_KEY ?? "";
const MINIMAX_BASE_URL =
  process.env.MINIMAX_BASE_URL?.trim() || "https://api.minimax.io/anthropic";
const MINIMAX_MODEL = process.env.MINIMAX_MODEL?.trim() || "MiniMax-M2.1";
const LIVE = process.env.MINIMAX_LIVE_TEST === "1" || process.env.LIVE === "1";

const describeLive = LIVE && MINIMAX_KEY ? describe : describe.skip;

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
    const res = await completeSimple(
      model,
      {
        messages: [
          {
            role: "user",
            content: "Reply with the word ok.",
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: MINIMAX_KEY, maxTokens: 64 },
    );
    const text = res.content
      .filter((block) => block.type === "text")
      .map((block) => block.text.trim())
      .join(" ");
    expect(text.length).toBeGreaterThan(0);
  }, 20000);
});
