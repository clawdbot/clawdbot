import { describe, expect, it } from "vitest";
import { startQaMockOpenAiServer } from "./server.js";

describe("mock Responses contract", () => {
  it.each([undefined, false])("returns a JSON Response when stream is %s", async (stream) => {
    const server = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });
    try {
      const response = await fetch(`${server.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "qa-model",
          ...(stream === undefined ? {} : { stream }),
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "Reply exactly: QA-RESPONSE-CONTRACT" }],
            },
          ],
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toMatchObject({
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "QA-RESPONSE-CONTRACT" }],
          },
        ],
      });
    } finally {
      await server.stop();
    }
  });
});
