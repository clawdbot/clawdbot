// Z.ai live tests verify GLM completions against the real provider when live
// credentials and live-test flags are enabled.
import { completeSimple, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  createSingleUserPromptMessage,
  extractNonEmptyAssistantText,
  isLiveTestEnabled,
} from "./live-test-helpers.js";
import { shouldSkipLiveProviderDrift } from "./live-test-provider-drift.js";

const ZAI_KEY = process.env.ZAI_API_KEY ?? process.env.Z_AI_API_KEY ?? "";
const LIVE = isLiveTestEnabled(["ZAI_LIVE_TEST"]);
const CODING_LIVE = isTruthyEnvValue(process.env.ZAI_CODING_LIVE_TEST);
const ZAI_LIVE_TIMEOUT_MS = 45_000;
const ZAI_GLOBAL_BASE_URL = "https://api.z.ai/api/paas/v4";
const ZAI_CODING_GLOBAL_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

const describeLive = LIVE && !CODING_LIVE && ZAI_KEY ? describe : describe.skip;
const describeCodingLive = CODING_LIVE && ZAI_KEY ? describe : describe.skip;

async function expectModelReturnsAssistantText(
  modelId: "glm-5.2" | "glm-5-turbo" | "glm-5.1",
  baseUrl = ZAI_GLOBAL_BASE_URL,
) {
  const model: Model<"openai-completions"> = {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "zai",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelId === "glm-5.2" ? 1_000_000 : 202_800,
    maxTokens: modelId === "glm-5.2" ? 131_072 : 131_100,
  };
  const complete = (maxTokens: number) =>
    completeSimple(
      model,
      {
        messages: createSingleUserPromptMessage(),
      },
      { apiKey: ZAI_KEY, maxTokens },
    );

  // A small probe cap can occasionally yield only hidden reasoning even though
  // production allows much more output. Retry once, but still require visible text.
  const initial = await complete(1_024);
  let final = initial;
  let text = extractNonEmptyAssistantText(final.content);
  if (!text && (initial.stopReason === "stop" || initial.stopReason === "length")) {
    final = await complete(8_192);
    text = extractNonEmptyAssistantText(final.content);
  }
  const drift = shouldSkipLiveProviderDrift({
    allowAuth: true,
    allowBilling: true,
    allowModelNotFound: true,
    allowProviderUnavailable: true,
    allowRateLimit: true,
    allowTimeout: true,
    error: final.errorMessage ?? "",
  });
  const errorClass = final.errorMessage ? (drift?.reason ?? "unclassified") : "none";
  expect(
    text.length,
    `${modelId} returned no assistant text; initialStopReason=${initial.stopReason}; finalStopReason=${final.stopReason}; errorClass=${errorClass}; contentTypes=${final.content.map((block) => block.type).join(",") || "none"}`,
  ).toBeGreaterThan(0);
}

describeCodingLive("zai Coding Plan live", () => {
  it(
    "glm-5.2 returns assistant text through the Coding Plan endpoint",
    async () => {
      await expectModelReturnsAssistantText("glm-5.2", ZAI_CODING_GLOBAL_BASE_URL);
    },
    ZAI_LIVE_TIMEOUT_MS,
  );
});

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
