import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";

const ollamaApiKey = process.env.OLLAMA_API_KEY?.trim() ?? "";
const LIVE =
  isLiveTestEnabled(["OPENCLAW_LIVE_TEST", "OLLAMA_LIVE_TEST"]) && ollamaApiKey.length > 0;
const describeLive = LIVE ? describe : describe.skip;

// Live proof for the `adaptive` thinking tier added in #128757:
// 1. the OpenClaw-only `adaptive` tier maps to native Ollama high effort, and
// 2. a real Ollama Cloud thinking-capable model accepts the mapped `think: "high"` payload.
describeLive("ollama adaptive thinking (live proof)", () => {
  it("maps the OpenClaw-only adaptive tier to native Ollama high effort", async () => {
    const { resolveOllamaThinkParamValue } = await import("./src/stream-compat.js");
    expect(resolveOllamaThinkParamValue({ think: "adaptive" }, true)).toBe("high");
  });

  it("ollama-cloud gpt-oss:20b accepts the adaptive-mapped think:high payload", async () => {
    const res = await fetch("https://ollama.com/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ollamaApiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-oss:20b",
        messages: [{ role: "user", content: "Reply with exactly the word: hi" }],
        think: "high",
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { message?: { content?: string } };
    expect(data.message?.content?.toLowerCase().includes("hi")).toBe(true);
  }, 60_000);
});
