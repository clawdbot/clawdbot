// OpenAI stream wrapper tests cover streamed text, tools, and reasoning fields.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import {
  createOpenAIAttributionHeadersWrapper,
  createOpenAICompletionsStrictMessageKeysWrapper,
  createOpenAICompletionsToolsCompatWrapper,
  createOpenAIFastModeWrapper,
  createOpenAIThinkingLevelWrapper,
  createCodexNativeWebSearchWrapper,
} from "./openai.js";

function createPayloadCapture(opts?: { initialReasoning?: unknown }) {
  const payloads: Array<Record<string, unknown>> = [];
  const baseStreamFn: StreamFn = (model, context, options) => {
    const payload: Record<string, unknown> = { model: model.id };
    if (opts?.initialReasoning !== undefined) {
      payload.reasoning = structuredClone(opts.initialReasoning);
    }
    options?.onPayload?.(payload, model);
    payloads.push(structuredClone(payload));
    return createAssistantMessageEventStream();
  };
  return { baseStreamFn, payloads };
}

const codexModel = {
  api: "openai-chatgpt-responses",
  provider: "openai",
  id: "gpt-5.1-codex",
} as Model<"openai-chatgpt-responses">;

const openaiModel = {
  api: "openai-responses",
  provider: "openai",
  id: "gpt-5.2",
  baseUrl: "https://api.openai.com/v1",
} as Model<"openai-responses">;

describe("createOpenAIFastModeWrapper", () => {
  it("resolves dynamic fast mode for each stream call", () => {
    const { baseStreamFn, payloads } = createPayloadCapture();
    let enabled = true;
    const wrapped = createOpenAIFastModeWrapper(baseStreamFn, () => enabled);

    void wrapped(openaiModel, { messages: [] }, {});
    enabled = false;
    void wrapped(openaiModel, { messages: [] }, {});

    expect(payloads[0]?.service_tier).toBe("priority");
    expect(payloads[1]).not.toHaveProperty("service_tier");
  });
});

describe("createOpenAICompletionsToolsCompatWrapper", () => {
  it("strips tools fields when OpenAI-compatible models disable tool support", () => {
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        model: model.id,
        tools: [{ type: "function", function: { name: "noop" } }],
        tool_choice: "auto",
        parallel_tool_calls: true,
      };
      options?.onPayload?.(payload, model);
      payloads.push(structuredClone(payload));
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenAICompletionsToolsCompatWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        provider: "venice",
        id: "chat-only-model",
        baseUrl: "https://example.invalid/v1",
        compat: { supportsTools: false },
      } as unknown as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(payloads[0]).not.toHaveProperty("tools");
    expect(payloads[0]).not.toHaveProperty("tool_choice");
    expect(payloads[0]).not.toHaveProperty("parallel_tool_calls");
  });

  it("keeps tools fields for OpenAI-compatible models without an explicit opt-out", () => {
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        model: model.id,
        tools: [{ type: "function", function: { name: "noop" } }],
      };
      options?.onPayload?.(payload, model);
      payloads.push(structuredClone(payload));
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenAICompletionsToolsCompatWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        provider: "venice",
        id: "tool-capable-model",
        baseUrl: "https://example.invalid/v1",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(payloads[0]).toHaveProperty("tools");
  });
});

describe("createCodexNativeWebSearchWrapper", () => {
  it("does not inject native web_search when code mode owns the tool surface", () => {
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        model: model.id,
        tools: [
          { type: "function", name: "exec" },
          { type: "function", name: "wait" },
          { type: "function", name: "web_search" },
          { type: "web_search" },
        ],
      };
      options?.onPayload?.(payload, model);
      payloads.push(structuredClone(payload));
      return createAssistantMessageEventStream();
    };
    const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
      config: {
        tools: {
          codeMode: { enabled: true },
          web: {
            search: {
              enabled: true,
              openaiCodex: { enabled: true, mode: "cached" },
            },
          },
        },
      },
    });

    void wrapped(
      {
        api: "openai-chatgpt-responses",
        provider: "gateway",
        id: "gpt-5.5",
      } as Model<"openai-chatgpt-responses">,
      {
        messages: [],
        tools: [
          { name: "exec", description: "", parameters: {} },
          { name: "wait", description: "", parameters: {} },
        ],
      },
      {
        onPayload: (payload) => {
          const payloadObj = payload as { tools?: unknown } | undefined;
          if (payloadObj && Array.isArray(payloadObj.tools)) {
            payloadObj.tools.push({ type: "function", name: "web_search" });
            payloadObj.tools.push({
              type: "function",
              get function(): { name: string } {
                throw new Error("code mode payload function getter exploded");
              },
            });
          }
        },
      },
    );

    expect(payloads[0]?.tools).toEqual([
      { type: "function", name: "exec" },
      { type: "function", name: "wait" },
    ]);
  });

  it("filters async replacement payloads when code mode owns the tool surface", async () => {
    let observedOptions: Parameters<StreamFn>[2];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      observedOptions = options;
      return createAssistantMessageEventStream();
    };
    const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
      codeModeToolSurfaceEnabled: true,
    });
    const model = {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5.5",
    } as Model<"openai-responses">;

    void wrapped(
      model,
      {
        messages: [],
        tools: [
          { name: "exec", description: "", parameters: {} },
          { name: "wait", description: "", parameters: {} },
        ],
      },
      {
        onPayload: async () => ({
          tools: [
            { type: "function", name: "exec" },
            {
              type: "function",
              get function(): { name: string } {
                throw new Error("async code mode payload function getter exploded");
              },
            },
            { type: "function", name: "wait" },
            { type: "web_search" },
          ],
        }),
      },
    );

    const nextPayload = await observedOptions?.onPayload?.({ tools: [] }, model);
    expect(nextPayload).toEqual({
      tools: [
        { type: "function", name: "exec" },
        { type: "function", name: "wait" },
      ],
    });
  });

  it("does not enable code-mode transport enforcement when config is on but controls are inactive", () => {
    const observedOptions: Array<Record<string, unknown>> = [];
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, context, options) => {
      observedOptions.push(options as Record<string, unknown>);
      const payload: Record<string, unknown> = { model: model.id };
      options?.onPayload?.(payload, model);
      payloads.push(structuredClone(payload));
      return createAssistantMessageEventStream();
    };
    const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
      config: {
        tools: {
          codeMode: { enabled: true },
        },
      },
    });

    void wrapped(
      {
        api: "openai-chatgpt-responses",
        provider: "gateway",
        id: "gpt-5.5",
      } as Model<"openai-chatgpt-responses">,
      { messages: [] },
      {},
    );

    expect(observedOptions[0]?.openclawCodeModeToolSurface).toBeUndefined();
    expect(payloads[0]).toEqual({ model: "gpt-5.5" });
  });

  it("enforces the code-mode transport surface when the run enables it at agent scope", () => {
    const observedOptions: Array<Record<string, unknown>> = [];
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, context, options) => {
      observedOptions.push(options as Record<string, unknown>);
      const payload: Record<string, unknown> = {
        model: model.id,
        tools: [
          { type: "function", name: "exec" },
          { type: "function", name: "wait" },
          { type: "function", name: "read" },
        ],
      };
      options?.onPayload?.(payload, model);
      payloads.push(structuredClone(payload));
      return createAssistantMessageEventStream();
    };
    const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
      codeModeToolSurfaceEnabled: true,
    });

    void wrapped(
      {
        api: "openai-chatgpt-responses",
        provider: "gateway",
        id: "gpt-5.5",
      } as Model<"openai-chatgpt-responses">,
      {
        messages: [],
        tools: [
          { name: "exec", description: "", parameters: {} },
          { name: "wait", description: "", parameters: {} },
        ],
      },
      {},
    );

    expect(observedOptions[0]?.openclawCodeModeToolSurface).toBe(true);
    expect(payloads[0]?.tools).toEqual([
      { type: "function", name: "exec" },
      { type: "function", name: "wait" },
    ]);
  });

  it("keeps grouped provider tool declarations when code mode filters the payload", () => {
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        model: model.id,
        tools: [
          {
            functionDeclarations: [
              { name: "exec", description: "Run code" },
              { name: "read", description: "Read a file" },
              { name: "wait", description: "Resume code" },
            ],
          },
          { google_search: {} },
        ],
      };
      options?.onPayload?.(payload, model);
      payloads.push(structuredClone(payload));
      return createAssistantMessageEventStream();
    };
    const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
      codeModeToolSurfaceEnabled: true,
    });

    void wrapped(
      {
        api: "google-generative-ai",
        provider: "google",
        id: "gemini-3.1-pro",
      } as never,
      {
        messages: [],
        tools: [
          { name: "exec", description: "", parameters: {} },
          { name: "wait", description: "", parameters: {} },
        ],
      },
      {},
    );

    expect(payloads[0]?.tools).toEqual([
      {
        functionDeclarations: [
          { name: "exec", description: "Run code" },
          { name: "wait", description: "Resume code" },
        ],
      },
    ]);
  });

  it("does not inject native web_search when agent policy denies web search", () => {
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload: Record<string, unknown> = {
        model: model.id,
        tools: [{ type: "function", name: "read" }],
      };
      options?.onPayload?.(payload, model);
      payloads.push(structuredClone(payload));
      return createAssistantMessageEventStream();
    };
    const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
      agentId: "main",
      config: {
        agents: {
          list: [
            {
              id: "main",
              tools: { deny: ["group:web"] },
            },
          ],
        },
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: { enabled: true, mode: "cached" },
            },
          },
        },
      },
    });

    void wrapped(
      {
        api: "openai-chatgpt-responses",
        provider: "gateway",
        id: "gpt-5.5",
      } as Model<"openai-chatgpt-responses">,
      { messages: [] },
      {},
    );

    expect(payloads[0]?.tools).toEqual([{ type: "function", name: "read" }]);
  });

  it("does not inject native web_search when runtime sender policy denies web search", () => {
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload: Record<string, unknown> = {
        model: model.id,
        tools: [{ type: "function", name: "read" }],
      };
      options?.onPayload?.(payload, model);
      payloads.push(structuredClone(payload));
      return createAssistantMessageEventStream();
    };
    const wrapped = createCodexNativeWebSearchWrapper(baseStreamFn, {
      messageProvider: "teams",
      senderId: "alice",
      config: {
        tools: {
          toolsBySender: {
            "channel:msteams:alice": { deny: ["web_search"] },
          },
          web: {
            search: {
              enabled: true,
              openaiCodex: { enabled: true, mode: "cached" },
            },
          },
        },
      },
    });

    void wrapped(
      {
        api: "openai-chatgpt-responses",
        provider: "gateway",
        id: "gpt-5.5",
      } as Model<"openai-chatgpt-responses">,
      { messages: [] },
      {},
    );

    expect(payloads[0]?.tools).toEqual([{ type: "function", name: "read" }]);
  });
});

describe("createOpenAICompletionsStrictMessageKeysWrapper", () => {
  it("strips message keys to role and content for strict OpenAI-compatible endpoints", () => {
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        model: model.id,
        messages: [
          {
            role: "assistant",
            content: "calling tool",
            name: "agent",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "noop" } }],
            cache_control: { type: "ephemeral" },
          },
          {
            role: "tool",
            content: "tool result",
            tool_call_id: "call_1",
          },
        ],
      };
      options?.onPayload?.(payload, model);
      payloads.push(structuredClone(payload));
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenAICompletionsStrictMessageKeysWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        provider: "infomaniak",
        id: "mistral3",
        baseUrl: "https://api.infomaniak.com/1/ai/example/openai",
        compat: { strictMessageKeys: true },
      } as unknown as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(payloads[0]?.messages).toEqual([
      { role: "assistant", content: "calling tool" },
      { role: "tool", content: "tool result" },
    ]);
  });
});

describe("createOpenAIThinkingLevelWrapper", () => {
  it("overrides effort on reasoning-capable model when thinkingLevel is medium", () => {
    const { baseStreamFn, payloads } = createPayloadCapture({
      initialReasoning: { effort: "none" },
    });
    const wrapped = createOpenAIThinkingLevelWrapper(baseStreamFn, "medium");
    void wrapped(codexModel, { messages: [] }, {});

    expect(payloads[0]?.reasoning).toEqual({ effort: "medium" });
  });

  it("overrides effort on reasoning-capable model when thinkingLevel is high", () => {
    const { baseStreamFn, payloads } = createPayloadCapture({
      initialReasoning: { effort: "none" },
    });
    const wrapped = createOpenAIThinkingLevelWrapper(baseStreamFn, "high");
    void wrapped(openaiModel, { messages: [] }, {});

    expect(payloads[0]?.reasoning).toEqual({ effort: "high" });
  });

  it("removes reasoning when thinkingLevel is off on reasoning-capable model", () => {
    const { baseStreamFn, payloads } = createPayloadCapture({
      initialReasoning: { effort: "medium" },
    });
    const wrapped = createOpenAIThinkingLevelWrapper(baseStreamFn, "off");
    void wrapped(codexModel, { messages: [] }, {});

    expect(payloads[0]).not.toHaveProperty("reasoning");
  });

  it("maps adaptive thinkingLevel to medium effort on reasoning-capable model", () => {
    const { baseStreamFn, payloads } = createPayloadCapture({
      initialReasoning: { effort: "none" },
    });
    const wrapped = createOpenAIThinkingLevelWrapper(baseStreamFn, "adaptive");
    void wrapped(codexModel, { messages: [] }, {});

    expect(payloads[0]?.reasoning).toEqual({ effort: "medium" });
  });

  it("replaces string disabled reasoning when thinkingLevel is enabled", () => {
    const { baseStreamFn, payloads } = createPayloadCapture({ initialReasoning: "none" });
    const wrapped = createOpenAIThinkingLevelWrapper(baseStreamFn, "low");
    void wrapped(codexModel, { messages: [] }, {});

    expect(payloads[0]?.reasoning).toEqual({ effort: "low" });
  });

  it("does not add reasoning for non-reasoning models without existing reasoning payload", () => {
    const { baseStreamFn, payloads } = createPayloadCapture();
    const wrapped = createOpenAIThinkingLevelWrapper(baseStreamFn, "medium");
    void wrapped(openaiModel, { messages: [] }, {});

    expect(payloads[0]?.reasoning).toBeUndefined();
  });

  it("overrides existing reasoning.effort from upstream wrappers", () => {
    const { baseStreamFn, payloads } = createPayloadCapture({
      initialReasoning: { effort: "none" },
    });
    const wrapped = createOpenAIThinkingLevelWrapper(baseStreamFn, "medium");
    void wrapped(codexModel, { messages: [] }, {});

    expect(payloads[0]?.reasoning).toEqual({ effort: "medium" });
  });

  it("returns underlying streamFn unchanged when thinkingLevel is undefined", () => {
    const { baseStreamFn } = createPayloadCapture();
    const wrapped = createOpenAIThinkingLevelWrapper(baseStreamFn, undefined);
    expect(wrapped).toBe(baseStreamFn);
  });

  it("preserves other reasoning properties when overriding effort", () => {
    const { baseStreamFn, payloads } = createPayloadCapture({
      initialReasoning: { effort: "none", summary: "auto" },
    });
    const wrapped = createOpenAIThinkingLevelWrapper(baseStreamFn, "high");
    void wrapped(codexModel, { messages: [] }, {});

    expect(payloads[0]?.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("does not inject reasoning for completions API on proxy routes", () => {
    const { baseStreamFn, payloads } = createPayloadCapture();
    const wrapped = createOpenAIThinkingLevelWrapper(baseStreamFn, "medium");
    void wrapped(
      {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-4o",
        baseUrl: "https://proxy.example.com/v1",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(payloads[0]?.reasoning).toBeUndefined();
  });

  it("does not inject reasoning for proxy routes with custom baseUrl", () => {
    const { baseStreamFn, payloads } = createPayloadCapture();
    const wrapped = createOpenAIThinkingLevelWrapper(baseStreamFn, "medium");
    void wrapped(
      {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.2",
        baseUrl: "https://proxy.example.com/v1",
      } as Model<"openai-responses">,
      { messages: [] },
      {},
    );

    expect(payloads[0]?.reasoning).toBeUndefined();
  });

  it("passes through all thinking levels correctly on reasoning-capable models", () => {
    const levels = ["minimal", "low", "medium", "high", "xhigh"] as const;
    for (const level of levels) {
      const { baseStreamFn, payloads } = createPayloadCapture({
        initialReasoning: { effort: "none" },
      });
      const wrapped = createOpenAIThinkingLevelWrapper(baseStreamFn, level);
      void wrapped(codexModel, { messages: [] }, {});
      expect(payloads[0]?.reasoning).toEqual({ effort: level });
    }
  });

  it("raises minimal reasoning for web_search on loopback Responses routes", () => {
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        reasoning: { effort: "minimal", summary: "auto" },
        tools: [{ type: "function", name: "web_search" }],
      };
      options?.onPayload?.(payload, model);
      payloads.push(structuredClone(payload));
      return createAssistantMessageEventStream();
    };
    const wrapped = createOpenAIThinkingLevelWrapper(baseStreamFn, "minimal");
    void wrapped(
      {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "http://127.0.0.1:19191/v1",
      } as Model<"openai-responses">,
      { messages: [] },
      {},
    );

    expect(payloads[0]?.reasoning).toEqual({ effort: "low", summary: "auto" });
  });

  it.each([
    {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5.5",
    },
    {
      api: "openai-chatgpt-responses",
      provider: "openai",
      id: "gpt-5.5",
    },
  ] as const)("preserves xhigh for $provider/$id", (model) => {
    const { baseStreamFn, payloads } = createPayloadCapture({
      initialReasoning: { effort: "high" },
    });
    const wrapped = createOpenAIThinkingLevelWrapper(baseStreamFn, "xhigh");
    void wrapped(model as Model<typeof model.api>, { messages: [] }, {});

    expect(payloads[0]?.reasoning).toEqual({ effort: "xhigh" });
  });

  it("preserves max for native GPT-5.6 models", () => {
    const { baseStreamFn, payloads } = createPayloadCapture({
      initialReasoning: { effort: "xhigh", summary: "auto" },
    });
    const wrapped = createOpenAIThinkingLevelWrapper(baseStreamFn, "max");
    void wrapped(
      {
        ...openaiModel,
        id: "gpt-5.6-sol",
      },
      { messages: [] },
      {},
    );

    expect(payloads[0]?.reasoning).toEqual({ effort: "max", summary: "auto" });
  });

  it("raises unsupported minimal reasoning to low for native GPT-5.6 models", () => {
    const { baseStreamFn, payloads } = createPayloadCapture({
      initialReasoning: { effort: "minimal", summary: "auto" },
    });
    const wrapped = createOpenAIThinkingLevelWrapper(baseStreamFn, "minimal");
    void wrapped(
      {
        ...openaiModel,
        id: "gpt-5.6-luna",
      },
      { messages: [] },
      {},
    );

    expect(payloads[0]?.reasoning).toEqual({ effort: "low", summary: "auto" });
  });

  it("keeps max clamped to xhigh for earlier OpenAI and Azure models", () => {
    const models = [
      { ...openaiModel, id: "gpt-5.5" },
      {
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-5.6-sol",
        baseUrl: "https://example.openai.azure.com/openai",
      } as Model<"azure-openai-responses">,
    ];

    for (const model of models) {
      const { baseStreamFn, payloads } = createPayloadCapture({
        initialReasoning: { effort: "high" },
      });
      const wrapped = createOpenAIThinkingLevelWrapper(baseStreamFn, "max");
      void wrapped(model, { messages: [] }, {});
      expect(payloads[0]?.reasoning).toEqual({ effort: "xhigh" });
    }
  });
});

describe("createOpenAIAttributionHeadersWrapper", () => {
  it("routes native Codex traffic through the OpenClaw transport so attribution survives OpenClaw defaults", () => {
    let codexCalls = 0;
    let capturedHeaders: Record<string, string> | undefined;
    const codexTransport: StreamFn = (model, context, options) => {
      codexCalls += 1;
      capturedHeaders = options?.headers;
      return createAssistantMessageEventStream();
    };
    const wrapped = createOpenAIAttributionHeadersWrapper(undefined, {
      codexNativeTransportStreamFn: codexTransport,
    });

    void wrapped(
      {
        ...codexModel,
        baseUrl: "https://chatgpt.com/backend-api",
      } as Model<"openai-chatgpt-responses">,
      { messages: [] },
      {
        headers: {
          originator: "openclaw",
          "User-Agent": "openclaw",
        },
      },
    );

    expect(codexCalls).toBe(1);
    expect(capturedHeaders?.originator).toBe("openclaw");
    expect(capturedHeaders?.["User-Agent"]).toMatch(/^openclaw\//);
  });

  it("keeps existing wrapped Codex streams so runtime OAuth injection is preserved", () => {
    let upstreamCalls = 0;
    let codexCalls = 0;
    let capturedOptions:
      | {
          apiKey?: string;
          headers?: Record<string, string>;
        }
      | undefined;
    const upstream: StreamFn = (model, context, options) => {
      upstreamCalls += 1;
      capturedOptions = options;
      return createAssistantMessageEventStream();
    };
    const codexTransport: StreamFn = () => {
      codexCalls += 1;
      return createAssistantMessageEventStream();
    };
    const wrapped = createOpenAIAttributionHeadersWrapper(upstream, {
      codexNativeTransportStreamFn: codexTransport,
    });

    void wrapped(
      {
        ...codexModel,
        baseUrl: "https://chatgpt.com/backend-api",
      } as Model<"openai-chatgpt-responses">,
      { messages: [] },
      {
        apiKey: "oauth-bearer-token",
        headers: {
          originator: "openclaw",
          "User-Agent": "openclaw",
        },
      },
    );

    expect(upstreamCalls).toBe(1);
    expect(codexCalls).toBe(0);
    expect(capturedOptions?.apiKey).toBe("oauth-bearer-token");
    expect(capturedOptions?.headers?.originator).toBe("openclaw");
    expect(capturedOptions?.headers?.["User-Agent"]).toMatch(/^openclaw\//);
  });
});
