// Together tests cover together plugin behavior.
import { completeSimple, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { TOGETHER_BASE_URL, TOGETHER_MODEL_CATALOG } from "./models.js";

const TOGETHER_KEY = process.env.TOGETHER_API_KEY ?? "";
const LIVE = ["LIVE", "OPENCLAW_LIVE_TEST", "TOGETHER_LIVE_TEST"].some((name) => {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
});
const TOGETHER_LIVE_TIMEOUT_MS = 45_000;

const describeLive = LIVE && TOGETHER_KEY ? describe : describe.skip;

function normalizeOpenAiCompletionInput(
  input: (typeof TOGETHER_MODEL_CATALOG)[number]["input"],
): Array<"text" | "image"> {
  const supported = input.filter((value): value is "text" | "image" => {
    return value === "text" || value === "image";
  });
  return supported.length > 0 ? supported : ["text"];
}

function buildLiveModel(model: (typeof TOGETHER_MODEL_CATALOG)[number]) {
  return {
    ...model,
    api: "openai-completions",
    provider: "together",
    baseUrl: TOGETHER_BASE_URL,
    input: normalizeOpenAiCompletionInput(model.input),
    cost: { ...model.cost },
  } satisfies Model<"openai-completions">;
}

function extractAssistantText(
  content: Array<{
    type?: string;
    text?: string;
  }>,
) {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
}

describeLive("together live catalog", () => {
  for (const catalogModel of TOGETHER_MODEL_CATALOG) {
    it(
      `${catalogModel.id} returns assistant text`,
      async () => {
        const model = buildLiveModel(catalogModel);
        const context = {
          messages: [
            {
              role: "user" as const,
              content: "Reply with the word ok.",
              timestamp: Date.now(),
            },
          ],
        };
        let response = await completeSimple(model, context, {
          apiKey: TOGETHER_KEY,
          maxTokens: 128,
        });
        let text = extractAssistantText(response.content);
        if (text.length === 0 && response.stopReason === "length") {
          response = await completeSimple(model, context, {
            apiKey: TOGETHER_KEY,
            maxTokens: 512,
          });
          text = extractAssistantText(response.content);
        }
        expect(text.length).toBeGreaterThan(0);
      },
      TOGETHER_LIVE_TIMEOUT_MS,
    );
  }
});
