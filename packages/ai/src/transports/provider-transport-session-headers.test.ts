import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { streamSimpleGoogle } from "../providers/google.js";
import type { Model } from "../types.js";
import { createBoundaryAwareStreamFnForModel } from "./provider-transport-stream.js";

const initialHost = getAiTransportHost();

afterEach(() => {
  configureAiTransportHost(initialHost);
  vi.unstubAllGlobals();
});

describe("managed OpenCode conversation headers at fetch egress", () => {
  it.each([
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ] as const)("preserves conversation identity through %s", async (api) => {
    const requests: Request[] = [];
    const captureFetch: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ error: { message: "request captured" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };
    vi.stubGlobal("fetch", captureFetch);
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: () => captureFetch,
      plugin: {
        ...initialHost.plugin,
        resolveProviderStream: () => (model, context, options) => {
          // The plugin boundary must receive identity before any SDK adapter can add it.
          if (!model.headers?.["X-OpenCode-Session"]) {
            expect(options?.headers?.["x-opencode-session"]).toBe("conversation-a");
          }
          return streamSimpleGoogle(
            { ...model, api: "google-generative-ai", compat: undefined },
            context,
            options,
          );
        },
      },
    });
    const baseModel = {
      id: "test-model",
      name: "Test model",
      api,
      provider: "opencode",
      baseUrl:
        api === "anthropic-messages" ? "https://opencode.ai/zen" : "https://opencode.ai/zen/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 128,
    } satisfies Model;

    for (const testCase of [
      { cacheRetention: "none", expected: "conversation-a" },
      { cacheRetention: "short", expected: "conversation-a" },
      {
        cacheRetention: "none",
        modelHeaders: { "X-OpenCode-Session": "model-session" },
        expected: "model-session",
      },
      {
        cacheRetention: "none",
        modelHeaders: { "X-OpenCode-Session": "model-session" },
        headers: { "x-opencode-session": "stream-session" },
        expected: "stream-session",
      },
    ] as const) {
      const model = {
        ...baseModel,
        headers: "modelHeaders" in testCase ? testCase.modelHeaders : undefined,
      };
      const streamFn = createBoundaryAwareStreamFnForModel(model);
      if (!streamFn) {
        throw new Error(`No managed transport for ${api}`);
      }
      requests.length = 0;
      const stream = await streamFn(
        model,
        {
          messages: [{ role: "user", content: "hello", timestamp: 1 }],
        },
        {
          apiKey: "test-key",
          sessionId: "conversation-a",
          cacheRetention: testCase.cacheRetention,
          headers: "headers" in testCase ? testCase.headers : undefined,
        },
      );
      await stream.result();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.get("x-opencode-session")).toBe(testCase.expected);
    }
  });
});
