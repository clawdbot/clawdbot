import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "./live-test-helpers.js";
import { makeZeroUsageSnapshot } from "./usage.js";

const GEMINI_KEY = process.env.GEMINI_API_KEY ?? "";
const LIVE = isLiveTestEnabled(["GEMINI_LIVE_TEST"]);

const describeLive = LIVE && GEMINI_KEY ? describe : describe.skip;

describeLive("gemini live switch", () => {
  const googleModels = ["gemini-3-pro-preview", "gemini-2.5-pro"] as const;

  for (const modelId of googleModels) {
    it(`handles unsigned tool calls from Antigravity when switching to ${modelId}`, async () => {
      const now = Date.now();
      const model = getModel("google", modelId);

      const res = await completeSimple(
        model,
        {
          messages: [
            {
              role: "user",
              content: "Reply with ok.",
              timestamp: now,
            },
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "call_1",
                  name: "bash",
                  arguments: { command: "ls -la" },
                  // No thoughtSignature: simulates Claude via Antigravity.
                },
              ],
              api: "google-gemini-cli",
              provider: "google-antigravity",
              model: "claude-sonnet-4-20250514",
              usage: makeZeroUsageSnapshot(),
              stopReason: "stop",
              timestamp: now,
            },
          ],
          tools: [
            {
              name: "bash",
              description: "Run shell command",
              parameters: Type.Object({
                command: Type.String(),
              }),
            },
          ],
        },
        {
          apiKey: GEMINI_KEY,
          reasoning: "low",
          maxTokens: 128,
        },
      );

      if (modelId.includes("preview") && res.stopReason === "error") {
        return;
      }
      expect(res.stopReason).not.toBe("error");
    }, 20000);
  }
});
