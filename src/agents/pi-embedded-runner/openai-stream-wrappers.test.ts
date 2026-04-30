import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createOpenAIAttributionHeadersWrapper,
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
  it("routes native Codex traffic through the OpenClaw transport instead of pi upstream", () => {
    let upstreamCalls = 0;
    let codexCalls = 0;
    let capturedHeaders: Record<string, string> | undefined;
    const upstream: StreamFn = () => {
      upstreamCalls += 1;
      return createAssistantMessageEventStream();
    };
    const codexTransport: StreamFn = (_model, _context, options) => {
      codexCalls += 1;
      capturedHeaders = options?.headers;
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
        headers: {
          originator: "pi",
          "User-Agent": "pi",
        },
      },
    );

    expect(upstreamCalls).toBe(0);
    expect(codexCalls).toBe(1);
    expect(capturedHeaders).toMatchObject({
      originator: "openclaw",
      "User-Agent": expect.stringMatching(/^openclaw\//),
    });
  });
});
