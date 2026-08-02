import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AssistantMessage, Context, Model } from "@openclaw/ai";
import { streamOpenAICompletions } from "@openclaw/ai/internal/openai";
import { describe, expect, it } from "vitest";
import {
  classifyAssistantFailoverReason,
  formatAssistantErrorText,
} from "./embedded-agent-helpers/errors.js";
import { resolveFailoverStatus, resolveModelFallbackError } from "./failover-error.js";

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

async function runAgainstOpenRouterStream(event: Record<string, unknown>) {
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address() as AddressInfo;
    return await streamOpenAICompletions(
      { ...model, baseUrl: `http://127.0.0.1:${address.port}/api/v1` },
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      { apiKey: ["test", "key"].join("-") },
    ).result();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function makeOpenRouterStreamEvent(params: {
  finishReason: string;
  error?: { code: number; message: string; metadata: { error_type: string } };
}): Record<string, unknown> {
  return {
    id: "gen-test",
    object: "chat.completion.chunk",
    created: 1,
    model: model.id,
    choices: [{ index: 0, delta: {}, finish_reason: params.finishReason }],
    ...(params.error ? { error: params.error } : {}),
  };
}

function expectFallbackBoundary(
  result: AssistantMessage,
  expected: { reason: "server_error" | "timeout"; status: number },
): void {
  const reason = classifyAssistantFailoverReason(result);
  expect(reason).toBe(expected.reason);
  if (!reason) {
    throw new Error("expected streamed provider error to be classified");
  }
  expect(resolveFailoverStatus(reason)).toBe(expected.status);

  const errorMessage = result.errorMessage;
  if (!errorMessage) {
    throw new Error("expected streamed provider error message");
  }
  const fallback = resolveModelFallbackError(new Error(errorMessage), {
    provider: model.provider,
    model: model.id,
  });
  expect(fallback.kind).toBe("failover");
  if (fallback.kind === "failover") {
    expect(fallback.error).toMatchObject(expected);
  }
}

describe("OpenRouter runtime error classification", () => {
  it("keeps a bare streamed finish_reason error eligible for server failover", async () => {
    const result = await runAgainstOpenRouterStream(
      makeOpenRouterStreamEvent({ finishReason: "error" }),
    );

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "Provider finish_reason: error",
    });
    expectFallbackBoundary(result, { reason: "server_error", status: 500 });
    expect(formatAssistantErrorText(result)).toBe("Provider finish_reason: error");
  });

  it("keeps a streamed network_error in the timeout lane", async () => {
    const result = await runAgainstOpenRouterStream(
      makeOpenRouterStreamEvent({ finishReason: "network_error" }),
    );

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "Provider finish_reason: network_error",
    });
    expectFallbackBoundary(result, { reason: "timeout", status: 408 });
  });

  it("preserves a structured streamed rate-limit classification", async () => {
    const result = await runAgainstOpenRouterStream(
      makeOpenRouterStreamEvent({
        finishReason: "error",
        error: {
          code: 429,
          message: "Rate limit exceeded",
          metadata: { error_type: "rate_limit_exceeded" },
        },
      }),
    );

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Rate limit exceeded");
    const reason = classifyAssistantFailoverReason(result);
    expect(reason).toBe("rate_limit");
    if (!reason) {
      throw new Error("expected structured rate-limit error to be classified");
    }
    expect(resolveFailoverStatus(reason)).toBe(429);
  });

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
