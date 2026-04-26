import { describe, expect, it } from "vitest";
import type { ResponseObject } from "./openai-ws-connection.js";
import { buildAssistantMessageFromResponse, convertTools } from "./openai-ws-message-conversion.js";

describe("openai ws message conversion", () => {
  it("preserves image_generate transparent-background guidance in OpenAI tool payloads", () => {
    const [tool] = convertTools([
      {
        name: "image_generate",
        description:
          'Generate images. For transparent OpenAI backgrounds, use outputFormat="png" or "webp" and openai.background="transparent"; OpenClaw routes the default OpenAI image model to gpt-image-1.5 for that mode.',
        parameters: {
          type: "object",
          properties: {
            model: {
              type: "string",
              description:
                "Optional provider/model override; use openai/gpt-image-1.5 for transparent OpenAI backgrounds.",
            },
            outputFormat: { type: "string", enum: ["png", "jpeg", "webp"] },
            openai: {
              type: "object",
              properties: {
                background: {
                  type: "string",
                  enum: ["transparent", "opaque", "auto"],
                  description:
                    "For transparent output use outputFormat png or webp; OpenClaw routes the default OpenAI image model to gpt-image-1.5 for this mode.",
                },
              },
            },
          },
        },
      },
    ]);

    expect(tool?.description).toContain('openai.background="transparent"');
    expect(tool?.description).toContain("gpt-image-1.5");
    expect(JSON.stringify(tool?.parameters)).toContain("openai/gpt-image-1.5");
    expect(JSON.stringify(tool?.parameters)).toContain("transparent");
  });

  it("preserves cached token usage from responses usage details", () => {
    const response: ResponseObject = {
      id: "resp_123",
      object: "response",
      created_at: Date.now(),
      status: "completed",
      model: "gpt-5",
      output: [
        {
          type: "message",
          id: "msg_123",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "hello" }],
        },
      ],
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        total_tokens: 250,
        input_tokens_details: { cached_tokens: 100 },
      },
    };

    const message = buildAssistantMessageFromResponse(response, {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
    });

    expect(message.usage).toMatchObject({
      input: 20,
      output: 30,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 250,
    });
  });

  it("derives cache-inclusive total tokens when responses total is missing", () => {
    const response: ResponseObject = {
      id: "resp_124",
      object: "response",
      created_at: Date.now(),
      status: "completed",
      model: "gpt-5",
      output: [
        {
          type: "message",
          id: "msg_124",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "hello" }],
        },
      ],
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        input_tokens_details: { cached_tokens: 100 },
      },
    };

    const message = buildAssistantMessageFromResponse(response, {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
    });

    expect(message.usage).toMatchObject({
      input: 20,
      output: 30,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 150,
    });
  });
});
