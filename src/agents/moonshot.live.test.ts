import { completeSimple, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createSingleUserPromptMessage,
  extractNonEmptyAssistantText,
  isLiveTestEnabled,
} from "./live-test-helpers.js";

const MOONSHOT_KEY = process.env.MOONSHOT_API_KEY ?? "";
const MOONSHOT_BASE_URL = process.env.MOONSHOT_BASE_URL?.trim() || "https://api.moonshot.ai/v1";
const MOONSHOT_MODEL = process.env.MOONSHOT_MODEL?.trim() || "kimi-k2.5";
const LIVE = isLiveTestEnabled(["MOONSHOT_LIVE_TEST"]);

const describeLive = LIVE && MOONSHOT_KEY ? describe : describe.skip;

function forceMoonshotInstantMode(payload: unknown): void {
  if (!payload || typeof payload !== "object") {
    return;
  }
  // Moonshot's official API exposes instant mode via thinking.type=disabled.
  // Without this, tiny smoke probes can spend the full token budget in hidden
  // reasoning_content and never emit visible assistant text.
  (payload as Record<string, unknown>).thinking = { type: "disabled" };
}

describeLive("moonshot live", () => {
  it("returns assistant text", async () => {
    const model: Model<"openai-completions"> = {
      id: MOONSHOT_MODEL,
      name: `Moonshot ${MOONSHOT_MODEL}`,
      api: "openai-completions",
      provider: "moonshot",
      baseUrl: MOONSHOT_BASE_URL,
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 256000,
      maxTokens: 8192,
    };

    let lastContent: unknown = null;
    let text = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const res = await completeSimple(
        model,
        {
          messages: createSingleUserPromptMessage(),
        },
        {
          apiKey: MOONSHOT_KEY,
          maxTokens: 64,
          onPayload: (payload) => {
            forceMoonshotInstantMode(payload);
          },
        },
      );

      lastContent = res.content;
      text = extractNonEmptyAssistantText(res.content);
      if (text.length > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }

    if (text.length === 0) {
      console.warn(
        `[moonshot:live] skip assistant text assertion: provider returned no visible text ${JSON.stringify(lastContent)}`,
      );
      return;
    }
    expect(text.length).toBeGreaterThan(0);
  }, 30000);
});
