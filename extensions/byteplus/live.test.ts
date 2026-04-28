import { completeSimple, type Model } from "@mariozechner/pi-ai";
import {
  createSingleUserPromptMessage,
  extractNonEmptyAssistantText,
  isLiveTestEnabled,
} from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { BYTEPLUS_CODING_BASE_URL, BYTEPLUS_DEFAULT_COST } from "./models.js";

const BYTEPLUS_KEY = process.env.BYTEPLUS_API_KEY ?? "";
const BYTEPLUS_CODING_MODEL = process.env.BYTEPLUS_CODING_MODEL?.trim() || "ark-code-latest";
const LIVE = isLiveTestEnabled(["BYTEPLUS_LIVE_TEST"]);

const describeLive = LIVE && BYTEPLUS_KEY ? describe : describe.skip;

function isBytePlusSubscriptionError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("coding plan subscription") ||
    lower.includes("subscription has expired") ||
    (lower.includes("subscription") && lower.includes("renewal"))
  );
}

describeLive("byteplus coding plan live", () => {
  it("returns assistant text", async () => {
    const model: Model<"openai-completions"> = {
      id: BYTEPLUS_CODING_MODEL,
      name: `BytePlus Coding ${BYTEPLUS_CODING_MODEL}`,
      api: "openai-completions",
      provider: "byteplus-plan",
      baseUrl: BYTEPLUS_CODING_BASE_URL,
      reasoning: false,
      input: ["text"],
      cost: BYTEPLUS_DEFAULT_COST,
      contextWindow: 256000,
      maxTokens: 4096,
    };

    const res = await completeSimple(
      model,
      {
        messages: createSingleUserPromptMessage(),
      },
      { apiKey: BYTEPLUS_KEY, maxTokens: 64 },
    );

    if (res.stopReason === "error") {
      const message = res.errorMessage ?? "";
      if (isBytePlusSubscriptionError(message)) {
        expect(message.toLowerCase()).toContain("subscription");
        return;
      }
      throw new Error(message || "byteplus returned error with no message");
    }

    const text = extractNonEmptyAssistantText(res.content);
    expect(text.length).toBeGreaterThan(0);
  }, 30000);
});
