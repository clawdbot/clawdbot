import { describe, expect, it } from "vitest";
import type { Context, Model } from "../types.js";
import { streamOpenAICodexResponses } from "./openai-chatgpt-responses.js";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-chatgpt-responses",
  provider: "openai",
  baseUrl: "https://chatgpt.test/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_000,
} satisfies Model<"openai-chatgpt-responses">;

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

async function capturePayload(requestContext: Context): Promise<Record<string, unknown>> {
  let capturedPayload: Record<string, unknown> | undefined;
  const result = await streamOpenAICodexResponses(model, requestContext, {
    apiKey: createJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
    }),
    transport: "sse",
    onPayload: (payload) => {
      capturedPayload = payload as Record<string, unknown>;
      throw new Error("stop after payload");
    },
  }).result();
  expect(result.stopReason).toBe("error");
  expect(capturedPayload).toBeDefined();
  return capturedPayload ?? {};
}

describe("ChatGPT Responses tool request controls", () => {
  it.each([
    ["absent", context],
    ["explicitly empty", { ...context, tools: [] }],
  ])("omits tool controls when tools are %s", async (_label, requestContext) => {
    const payload = await capturePayload(requestContext);

    expect(payload).not.toHaveProperty("tools");
    expect(payload).not.toHaveProperty("tool_choice");
    expect(payload).not.toHaveProperty("parallel_tool_calls");
  });

  it("keeps tool controls when a tool schema is usable", async () => {
    const payload = await capturePayload({
      ...context,
      tools: [
        {
          name: "lookup",
          description: "Look up a value.",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
    });

    expect(payload).toMatchObject({
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Look up a value.",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
    });
  });
});
