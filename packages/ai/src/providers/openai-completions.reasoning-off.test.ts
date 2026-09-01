// Guards the wire contract for a disabled session thinking level across every
// OpenAI-compatible thinking dialect, on both stream entry points.
import { describe, expect, it } from "vitest";
import { createBoundaryAwareStreamFnForModel } from "../transports/provider-transport-stream.js";
import type { Context, Model, SimpleStreamOptions } from "../types.js";
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "./openai-completions.js";

type Payload = Record<string, unknown>;

const CONTEXT = {
  systemPrompt: "system",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
} as unknown as Context;

function reasoningModel(overrides: Record<string, unknown>): Model<"openai-completions"> {
  return {
    id: "some-reasoning-model",
    name: "Some Reasoning Model",
    api: "openai-completions",
    provider: "acme",
    baseUrl: "https://api.acme.example/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
    compat: { supportsReasoningEffort: true },
    ...overrides,
  } as unknown as Model<"openai-completions">;
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const event of stream) {
      void event;
    }
  } catch {
    // The thrown onPayload surfaces as a stream error event, not a rejection.
  }
}

function payloadCaptor() {
  const seen: { payload?: Payload } = {};
  const onPayload = (payload: unknown) => {
    seen.payload = payload as Payload;
    // Stop before the client issues a request; the payload is the assertion target.
    throw new Error("captured");
  };
  return { seen, onPayload };
}

async function capturePayload(
  model: Model<"openai-completions">,
  reasoningEffort: string | undefined,
): Promise<Payload> {
  const { seen, onPayload } = payloadCaptor();
  await drain(
    streamOpenAICompletions(model, CONTEXT, {
      apiKey: "test-key",
      reasoningEffort,
      onPayload,
    } as never),
  );
  expect(seen.payload).toBeDefined();
  return seen.payload as Payload;
}

async function captureSimplePayload(
  model: Model<"openai-completions">,
  reasoning: SimpleStreamOptions["reasoning"],
): Promise<Payload> {
  const { seen, onPayload } = payloadCaptor();
  await drain(
    streamSimpleOpenAICompletions(model, CONTEXT, {
      apiKey: "test-key",
      reasoning,
      onPayload,
    } as never),
  );
  expect(seen.payload).toBeDefined();
  return seen.payload as Payload;
}

function withDialect(thinkingFormat: string) {
  return { compat: { supportsReasoningEffort: true, thinkingFormat } };
}

const DIALECTS = [
  {
    name: "openai",
    overrides: { thinkingLevelMap: { off: "none" } },
    disabled: { reasoning_effort: "none" },
  },
  {
    name: "openrouter",
    overrides: {
      compat: {
        supportsReasoningEffort: true,
        thinkingFormat: "openrouter",
        supportedReasoningEfforts: ["none", "low", "high"],
      },
    },
    disabled: { reasoning: { effort: "none" } },
  },
  { name: "zai", overrides: withDialect("zai"), disabled: { thinking: { type: "disabled" } } },
  {
    name: "deepseek",
    overrides: withDialect("deepseek"),
    disabled: { thinking: { type: "disabled" } },
  },
  {
    name: "together",
    overrides: withDialect("together"),
    disabled: { reasoning: { enabled: false } },
  },
  { name: "qwen", overrides: withDialect("qwen"), disabled: { enable_thinking: false } },
  {
    name: "qwen-chat-template",
    overrides: withDialect("qwen-chat-template"),
    disabled: { chat_template_kwargs: { enable_thinking: false, preserve_thinking: true } },
  },
] as const;

describe("openai completions disabled reasoning", () => {
  it.each(DIALECTS)(
    "sends the $name disabled-reasoning payload when the session level is off",
    async ({ overrides, disabled }) => {
      expect(await capturePayload(reasoningModel(overrides), "off")).toMatchObject(disabled);
    },
  );

  it.each(DIALECTS)(
    "never leaks the internal off level onto the $name wire payload",
    async ({ overrides }) => {
      const payload = await capturePayload(reasoningModel(overrides), "off");
      expect(JSON.stringify(payload)).not.toContain('"off"');
    },
  );

  it("omits reasoning entirely when the model declares no disabled wire value", async () => {
    // Endpoints disagree: some accept `none`, others require the field to be absent. With no
    // declared metadata OpenClaw must not guess, so it sends nothing.
    const payload = await captureSimplePayload(reasoningModel({}), "off");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("leaves endpoint reasoning defaults alone when the caller requests no level", async () => {
    expect(await captureSimplePayload(reasoningModel({}), undefined)).not.toHaveProperty(
      "reasoning_effort",
    );
    expect(await capturePayload(reasoningModel({}), undefined)).not.toHaveProperty(
      "reasoning_effort",
    );
  });

  it("still applies a model's off mapping when the caller requests no level", async () => {
    // Shipped Cohere and StepFun rows map off to none/low; gating this on an explicit
    // request would drop that mapping for callers that set no thinking level.
    const model = reasoningModel({ thinkingLevelMap: { off: "low" } });
    expect((await capturePayload(model, undefined)).reasoning_effort).toBe("low");
  });

  it("keeps an explicit off mapping instead of the canonical disabled value", async () => {
    const payload = await capturePayload(
      reasoningModel({ thinkingLevelMap: { off: "low" } }),
      "off",
    );
    expect(payload.reasoning_effort).toBe("low");
  });

  it("omits reasoning entirely when the model declares no disable switch", async () => {
    const payload = await capturePayload(
      reasoningModel({ thinkingLevelMap: { off: null } }),
      "off",
    );
    expect(payload).not.toHaveProperty("reasoning_effort");
  });
});

// The embedded runner resolves this transport for OpenAI-family APIs once a runtime key is
// available, so it is the builder a real agent turn goes through.
describe("boundary-aware completions transport disabled reasoning", () => {
  async function captureTransportPayload(
    model: Model<"openai-completions">,
    reasoning: string | undefined,
  ): Promise<Payload> {
    const streamFn = createBoundaryAwareStreamFnForModel(model as Model);
    expect(streamFn).toBeDefined();
    const { seen, onPayload } = payloadCaptor();
    await drain(
      (streamFn as NonNullable<typeof streamFn>)(model as Model, CONTEXT, {
        apiKey: "test-key",
        reasoning,
        onPayload,
      } as never) as AsyncIterable<unknown>,
    );
    expect(seen.payload).toBeDefined();
    return seen.payload as Payload;
  }

  it("sends the declared disabled value when the model declares one", async () => {
    const payload = await captureTransportPayload(
      reasoningModel({
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["none", "low", "high"],
        },
      }),
      "off",
    );
    expect(payload.reasoning_effort).toBe("none");
  });

  it("omits reasoning for a model that declares no disabled wire value", async () => {
    // Groq's OpenAI-completions rows ship without this metadata and its endpoint expects the
    // field to be absent for a disabled level.
    const payload = await captureTransportPayload(reasoningModel({}), "off");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("keeps an enabled level untouched", async () => {
    const payload = await captureTransportPayload(reasoningModel({}), "high");
    expect(payload.reasoning_effort).toBe("high");
  });

  it("disables openrouter reasoning through its own dialect", async () => {
    const payload = await captureTransportPayload(
      reasoningModel({
        compat: {
          supportsReasoningEffort: true,
          thinkingFormat: "openrouter",
          supportedReasoningEfforts: ["none", "low", "high"],
        },
      }),
      "off",
    );
    expect(payload.reasoning).toEqual({ effort: "none" });
  });

  it("leaves a declared vocabulary without a disabled value alone", async () => {
    const payload = await captureTransportPayload(
      reasoningModel({
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["low", "medium", "high"],
        },
      }),
      "off",
    );
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("uses the model's declared off mapping", async () => {
    const payload = await captureTransportPayload(
      reasoningModel({ thinkingLevelMap: { off: "low" } }),
      "off",
    );
    expect(payload.reasoning_effort).toBe("low");
  });

  it("does not turn reasoning on when the model declares no disable switch", async () => {
    // A null off mapping keeps `off` out of the model's levels, so the resolver forwards no
    // level at all. The transport defaults an unset level to high, which turned an explicit
    // off into a request for more thinking. It must stay absent instead.
    const payload = await captureTransportPayload(
      reasoningModel({ thinkingLevelMap: { off: null } }),
      undefined,
    );
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("does not add a redundant effort to a dialect that carries its own disable signal", async () => {
    const payload = await captureTransportPayload(reasoningModel(withDialect("together")), "off");
    expect(payload.reasoning).toEqual({ enabled: false });
    expect(payload).not.toHaveProperty("reasoning_effort");
  });
});
