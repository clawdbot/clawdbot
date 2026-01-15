import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";

const GEMINI_KEY = process.env.GEMINI_API_KEY ?? "";
const LIVE = process.env.GEMINI_LIVE_TEST === "1" || process.env.LIVE === "1";

const describeLive = LIVE && GEMINI_KEY ? describe : describe.skip;

describeLive("gemini live switch", () => {
  it("handles unsigned tool calls from Antigravity when switching to Gemini 3", async () => {
    const now = Date.now();
    const model = getModel("google", "gemini-3-pro-preview");

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
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "stop",
            timestamp: now,
          },
        ],
        tools: [
          {
            name: "bash",
            description: "Run shell command",
            parameters: {
              type: "object",
              properties: {
                command: { type: "string" },
              },
              required: ["command"],
            },
          },
        ],
      },
      {
        apiKey: GEMINI_KEY,
        reasoning: "low",
        maxTokens: 128,
      },
    );

    expect(res.stopReason).not.toBe("error");
  }, 20000);
});
