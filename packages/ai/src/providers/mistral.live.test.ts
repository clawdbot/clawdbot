import { describe, expect, it } from "vitest";
import type { Model } from "../types.js";
import { streamSimpleMistral } from "./mistral.js";

const apiKey = process.env.MISTRAL_API_KEY?.trim() ?? "";
const live = process.env.OPENCLAW_LIVE_TEST === "1" && apiKey.length > 0;
const describeLive = live ? describe : describe.skip;

const model: Model<"mistral-conversations"> = {
  id: "mistral-small-latest",
  name: "Mistral Small Latest",
  api: "mistral-conversations",
  provider: "mistral",
  baseUrl: "https://api.mistral.ai",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
  contextWindow: 256_000,
  maxTokens: 16_384,
};

describeLive("Mistral provider live", () => {
  it("streams a basic response and parses cache usage", async () => {
    const result = await streamSimpleMistral(
      model,
      { messages: [{ role: "user", content: "Reply with the single word ok.", timestamp: 0 }] },
      {
        apiKey,
        maxTokens: 32,
        sessionId: `openclaw-live-${Date.now()}`,
      },
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(result.usage.output).toBeGreaterThan(0);
    expect(result.usage.cacheRead).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
