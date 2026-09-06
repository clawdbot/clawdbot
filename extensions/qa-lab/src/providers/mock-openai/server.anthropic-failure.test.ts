import { describe, expect, it } from "vitest";
import { startQaMockOpenAiServer } from "./server.js";

describe.each([
  { name: "before output", prompt: "Telegram unsent failure QA check.", partialText: "" },
  {
    name: "after partial output",
    prompt: "Telegram visible partial failure QA check.",
    partialText: "TELEGRAM-VISIBLE-PARTIAL-BEFORE-FAILURE",
  },
])("Anthropic failure $name", ({ prompt, partialText }) => {
  it.each([false, true])("preserves failure when stream=%s", async (stream) => {
    const server = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });
    try {
      const response = await fetch(`${server.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "qa-model",
          max_tokens: 256,
          stream,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const body = await response.text();
      const expectedError = { type: "api_error", message: expect.any(String) };
      if (stream) {
        expect(response.status).toBe(200);
        const events = body
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)));
        expect(events.at(-1)).toMatchObject({ type: "error", error: expectedError });
        expect(body).not.toContain("event: message_stop");
        expect(body).not.toContain('"stop_reason":"end_turn"');
        expect(
          events
            .filter((event) => event.type === "content_block_delta")
            .map((event) => event.delta.text)
            .join(""),
        ).toBe(partialText);
      } else {
        expect(response.status).toBe(500);
        expect(JSON.parse(body)).toEqual({ type: "error", error: expectedError });
      }
    } finally {
      await server.stop();
    }
  });
});
