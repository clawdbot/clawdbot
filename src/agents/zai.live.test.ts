import { completeSimple, getModel } from "@mariozechner/pi-ai";
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
  const model = getModel("zai", modelId);
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
