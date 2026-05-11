import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createOpenAIAttributionHeadersWrapper,
  createOpenAICompletionsStrictMessageKeysWrapper,
  createOpenAICompletionsToolsCompatWrapper,
  createOpenAIThinkingLevelWrapper,
} from "./openai-stream-wrappers.js";

function createPayloadCapture(opts?: { initialReasoning?: unknown }) {
  const payloads: Array<Record<string, unknown>> = [];
  const baseStreamFn: StreamFn = (model, _context, options) => {
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
  api: "openai-codex-responses",
  provider: "openai-codex",
  id: "gpt-5.1-codex",
} as Model<"openai-codex-responses">;

const openaiModel = {
  api: "openai-responses",
  provider: "openai",
  id: "gpt-5.2",
} as Model<"openai-responses">;

describe("createOpenAICompletionsToolsCompatWrapper", () => {
  it("strips tools fields when OpenAI-compatible models disable tool support", () => {
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, _context, options) => {
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
    const baseStreamFn: StreamFn = (model, _context, options) => {
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

describe("createOpenAICompletionsStrictMessageKeysWrapper", () => {
  it("strips message keys to role and content for strict OpenAI-compatible endpoints", () => {
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn: StreamFn = (model, _context, options) => {
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
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        reasoning: { effort: "minimal", summary: "auto" },
        tools: [{ type: "function", name: "web_search" }],
      };
      options?.onPayload?.(payload, _model);
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
      api: "openai-codex-responses",
      provider: "openai-codex",
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
});

describe("createOpenAIAttributionHeadersWrapper", () => {
  it("routes native Codex traffic through the OpenClaw transport so attribution survives PI defaults", () => {
    let codexCalls = 0;
    let capturedHeaders: Record<string, string> | undefined;
    const codexTransport: StreamFn = (_model, _context, options) => {
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
      } as Model<"openai-codex-responses">,
      { messages: [] },
      {
        headers: {
          originator: "pi",
          "User-Agent": "pi",
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
    const upstream: StreamFn = (_model, _context, options) => {
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
      } as Model<"openai-codex-responses">,
      { messages: [] },
      {
        apiKey: "oauth-bearer-token",
        headers: {
          originator: "pi",
          "User-Agent": "pi",
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
