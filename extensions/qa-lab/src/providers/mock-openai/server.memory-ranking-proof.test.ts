import { describe, expect, it } from "vitest";
import { startQaMockOpenAiServer } from "./server.js";

describe("QA mock OpenAI session memory ranking", () => {
  it("plans an answer-free search across both configured memory sources", async () => {
    const server = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });

    try {
      const response = await fetch(`${server.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          stream: false,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Session memory ranking check: what is the current Project Nebula codename? Use memory tools first.",
                },
              ],
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        output?: Array<{ type?: string; name?: string; arguments?: string }>;
      };
      const searchCall = payload.output?.find(
        (item) => item.type === "function_call" && item.name === "memory_search",
      );
      expect(searchCall).toBeDefined();
      const args = JSON.parse(searchCall?.arguments ?? "null") as Record<string, unknown>;

      expect(args).toEqual({
        query: "current Project Nebula codename",
        maxResults: 6,
      });
      expect(JSON.stringify(args)).not.toMatch(/ORBIT-(?:9|10)/);
      expect(args).not.toHaveProperty("corpus");
    } finally {
      await server.stop();
    }
  });
});
