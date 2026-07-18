import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Context, Model } from "@openclaw/ai";
import { streamOpenAICompletions } from "@openclaw/ai/internal/openai";
import { describe, expect, it } from "vitest";
import { classifyAssistantFailoverReason } from "./embedded-agent-helpers/errors.js";

const model = {
  id: "example/model",
  name: "OpenRouter mock",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 1_024,
} satisfies Model<"openai-completions">;

async function runAgainstOpenRouterError(params: {
  message: string;
  context: Context;
}): Promise<{ reason: string | null; requestBody: string }> {
  let requestBody = "";
  const server = createServer((request, response) => {
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      requestBody += chunk;
    });
    request.on("end", () => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: 404, message: params.message } }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address() as AddressInfo;
    const result = await streamOpenAICompletions(
      { ...model, baseUrl: `http://127.0.0.1:${address.port}/api/v1` },
      params.context,
      { apiKey: ["test", "key"].join("-") },
    ).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(params.message);
    return { reason: classifyAssistantFailoverReason(result), requestBody };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("OpenRouter runtime error classification", () => {
  it("treats an image-capability 404 as a terminal format failure", async () => {
    const result = await runAgainstOpenRouterError({
      message: "No endpoints found that support image input",
      context: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe this" },
              { type: "image", mimeType: "image/png", data: "aW1n" },
            ],
            timestamp: 1,
          },
        ],
      },
    });

    expect(result.reason).toBe("format");
    expect(JSON.parse(result.requestBody)).toMatchObject({
      messages: [
        {
          content: [{ type: "text", text: "describe this" }, { type: "image_url" }],
        },
      ],
    });
  });

  it("keeps a genuine missing-model 404 eligible for model fallback", async () => {
    const result = await runAgainstOpenRouterError({
      message: "No endpoints found for missing/model.",
      context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    });

    expect(result.reason).toBe("model_not_found");
  });
});
