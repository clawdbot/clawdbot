import type { ApiRegistry } from "@openclaw/ai";
// Verifies the Google simple-completion wrapper and thinking-payload sanitizer hook.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../llm/types.js";

const streamSimple = vi.fn();
const sanitizeGoogleThinkingPayload = vi.fn();
const ensureCustomApiRegistered = vi.fn();
const apiRegistry = {
  getApiProvider: vi.fn(() => ({ streamSimple })),
} as unknown as ApiRegistry;

vi.mock("../llm/providers/stream-wrappers/google-thinking-payload.js", async () => {
  const actual = await vi.importActual<
    typeof import("../llm/providers/stream-wrappers/google-thinking-payload.js")
  >("../llm/providers/stream-wrappers/google-thinking-payload.js");
  return {
    ...actual,
    sanitizeGoogleThinkingPayload,
  };
});

vi.mock("./custom-api-registry.js", () => ({
  ensureCustomApiRegistered,
}));

const { prepareGoogleSimpleCompletionModel } = await import("./google-simple-completion-stream.js");

const GOOGLE_SIMPLE_COMPLETION_API = "openclaw-google-generative-ai-simple";

// Mirrors the provider catalog shape closely enough for wrapper registration
// without pulling live Google model discovery into unit tests.
function makeGoogleModel(
  id = "gemini-flash-latest",
  overrides: Partial<Model<"google-generative-ai">> = {},
): Model<"google-generative-ai"> {
  return {
    id,
    name: id,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 8192,
    headers: {},
    ...overrides,
  };
}

describe("prepareGoogleSimpleCompletionModel", () => {
  beforeEach(() => {
    streamSimple.mockReset();
    sanitizeGoogleThinkingPayload.mockReset();
    ensureCustomApiRegistered.mockReset();
    streamSimple.mockImplementation((_model, _context, options) => {
      const payload = {
        generationConfig: {
          thinkingConfig: { thinkingBudget: -1 },
        },
      };
      options?.onPayload?.(payload, _model);
      return { content: [{ type: "text", text: "ok" }], payload };
    });
  });

  it("returns non-Google models unchanged", () => {
    const model = {
      ...makeGoogleModel("gpt-5"),
      api: "openai-responses",
    } as unknown as Model<"openai-responses">;

    const result = prepareGoogleSimpleCompletionModel(apiRegistry, model);

    expect(result).toBe(model);
    expect(ensureCustomApiRegistered).not.toHaveBeenCalled();
  });

  it("registers an OpenClaw-owned Google simple-completion api alias", () => {
    const model = makeGoogleModel();

    const result = prepareGoogleSimpleCompletionModel(apiRegistry, model);

    expect(result).toEqual({
      ...model,
      api: GOOGLE_SIMPLE_COMPLETION_API,
    });
    expect(ensureCustomApiRegistered).toHaveBeenCalledTimes(1);
    expect(ensureCustomApiRegistered.mock.calls[0]?.[0]).toBe(apiRegistry);
    expect(ensureCustomApiRegistered.mock.calls[0]?.[1]).toBe(GOOGLE_SIMPLE_COMPLETION_API);
  });

  it.each(["off", "low", "medium", "high", "adaptive"] as const)(
    "sanitizes outbound thinking payload for gemini-flash-latest with reasoning=%s",
    async (reasoning) => {
      const model = makeGoogleModel();
      const wrapped = prepareGoogleSimpleCompletionModel(apiRegistry, model);
      const streamFn = ensureCustomApiRegistered.mock.calls[0]?.[2] as (
        ...args: unknown[]
      ) => unknown;

      // The custom alias must unwrap to the real Google API before delegating,
      // then sanitize the exact outbound payload produced by streamSimple.
      await streamFn(wrapped, { messages: [] }, { apiKey: "key", reasoning });

      expect(streamSimple).toHaveBeenCalledTimes(1);
      expect(streamSimple.mock.calls[0]?.[0]).toEqual({
        ...model,
        api: "google-generative-ai",
      });
      expect(sanitizeGoogleThinkingPayload).toHaveBeenCalledWith({
        payload: {
          generationConfig: {
            thinkingConfig: { thinkingBudget: -1 },
          },
        },
        modelId: "gemini-flash-latest",
        thinkingLevel: reasoning,
      });
    },
  );

  it("returns the sanitizer-mutated payload shape", async () => {
    sanitizeGoogleThinkingPayload.mockImplementationOnce((args: { payload: unknown }) => {
      const payload = args.payload as {
        generationConfig: { thinkingConfig: Record<string, unknown> };
      };
      delete payload.generationConfig.thinkingConfig.thinkingBudget;
      payload.generationConfig.thinkingConfig.thinkingLevel = "MINIMAL";
    });
    const model = makeGoogleModel();
    prepareGoogleSimpleCompletionModel(apiRegistry, model);
    const streamFn = ensureCustomApiRegistered.mock.calls[0]?.[2] as (
      ...args: unknown[]
    ) => unknown;

    const result = await streamFn(model, { messages: [] }, { apiKey: "key", reasoning: "off" });

    expect(result).toMatchObject({
      payload: {
        generationConfig: {
          thinkingConfig: {
            thinkingLevel: "MINIMAL",
          },
        },
      },
    });
    expect(
      (
        result as {
          payload: { generationConfig: { thinkingConfig: Record<string, unknown> } };
        }
      ).payload.generationConfig.thinkingConfig,
    ).not.toHaveProperty("thinkingBudget");
  });

  it.each(["xhigh", "max"] as const)(
    "preserves clamped-off intent in the final Gemini 3 payload for reasoning=%s",
    async (reasoning) => {
      const actual = await vi.importActual<
        typeof import("../llm/providers/stream-wrappers/google-thinking-payload.js")
      >("../llm/providers/stream-wrappers/google-thinking-payload.js");
      sanitizeGoogleThinkingPayload.mockImplementationOnce(actual.sanitizeGoogleThinkingPayload);
      streamSimple.mockImplementationOnce((_model, _context, options) => {
        const payload = {
          generationConfig: {
            thinkingConfig: { thinkingLevel: "MINIMAL" },
          },
        };
        options?.onPayload?.(payload, _model);
        return { content: [{ type: "text", text: "ok" }], payload };
      });
      const model = makeGoogleModel("gemini-3-flash-preview", {
        thinkingLevelMap: {
          minimal: null,
          low: null,
          medium: null,
          high: null,
          xhigh: null,
          max: null,
        },
      });
      const wrapped = prepareGoogleSimpleCompletionModel(apiRegistry, model);
      const streamFn = ensureCustomApiRegistered.mock.calls[0]?.[2] as (
        ...args: unknown[]
      ) => unknown;

      const result = await streamFn(wrapped, { messages: [] }, { apiKey: "key", reasoning });

      expect(sanitizeGoogleThinkingPayload).toHaveBeenCalledWith({
        payload: {
          generationConfig: {
            thinkingConfig: { thinkingLevel: "MINIMAL" },
          },
        },
        modelId: "gemini-3-flash-preview",
        thinkingLevel: "off",
      });
      expect(result).toMatchObject({
        payload: {
          generationConfig: {
            thinkingConfig: { thinkingLevel: "MINIMAL" },
          },
        },
      });
      expect(
        (
          result as {
            payload: { generationConfig: { thinkingConfig: Record<string, unknown> } };
          }
        ).payload.generationConfig.thinkingConfig,
      ).not.toHaveProperty("includeThoughts");
    },
  );
});
