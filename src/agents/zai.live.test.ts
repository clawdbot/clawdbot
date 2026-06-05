// Z.ai live tests verify GLM completions against the real provider when live
// credentials and live-test flags are enabled.
import { completeSimple, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import {
  createSingleUserPromptMessage,
  extractNonEmptyAssistantText,
  isLiveTestEnabled,
} from "./live-test-helpers.js";

const ZAI_KEY = process.env.ZAI_API_KEY ?? process.env.Z_AI_API_KEY ?? "";
const LIVE = isLiveTestEnabled(["ZAI_LIVE_TEST"]);
const ZAI_LIVE_TIMEOUT_MS = 45_000;

const describeLive = LIVE && ZAI_KEY ? describe : describe.skip;

async function expectModelReturnsAssistantText(modelId: "glm-5-turbo" | "glm-5.1") {
  const model: Model<"openai-completions"> = {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "zai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 202_800,
    maxTokens: 131_100,
  };
  const res = await completeSimple(
    model,
    {
      messages: createSingleUserPromptMessage(),
    },
    { apiKey: ZAI_KEY, maxTokens: 64 },
  );
  const text = extractNonEmptyAssistantText(res.content);
  expect(text.length).toBeGreaterThan(0);
}

describeLive("zai live", () => {
  it(
    "returns assistant text",
    async () => {
      await expectModelReturnsAssistantText("glm-5-turbo");
    },
    ZAI_LIVE_TIMEOUT_MS,
  );

  it(
    "glm-5.1 returns assistant text",
    async () => {
      await expectModelReturnsAssistantText("glm-5.1");
    },
    ZAI_LIVE_TIMEOUT_MS,
  );
});
