// Huggingface tests cover models plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverHuggingfaceModels,
  HUGGINGFACE_MODEL_CATALOG,
  isHuggingfacePolicyLocked,
} from "./api.js";

function stubAbortSignalTimeout() {
  const controller = new AbortController();
  return vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
}

function responseFromReader(reader: ReadableStreamDefaultReader<Uint8Array>): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "Content-Type": "application/json" }),
    body: { getReader: () => reader },
  } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("huggingface models", () => {
  it("does not advertise the retired Llama 3.3 Turbo route", () => {
    expect(HUGGINGFACE_MODEL_CATALOG.map((model) => model.id)).not.toContain(
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    );
  });

  it("discoverHuggingfaceModels returns static catalog when apiKey is empty", async () => {
    const models = await discoverHuggingfaceModels("");
    expect(models).toHaveLength(HUGGINGFACE_MODEL_CATALOG.length);
    expect(models.map((m) => m.id)).toEqual(HUGGINGFACE_MODEL_CATALOG.map((m) => m.id));
    expect(models[0]?.contextWindow).toBe(131072);
    expect(models[0]?.compat).toBeUndefined();
  });

  it("uses the live route context for bundled models while preserving their catalog metadata", async () => {
    const bundledModel = HUGGINGFACE_MODEL_CATALOG[0]!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            {
              id: bundledModel.id,
              name: "Upstream name must not replace bundled metadata",
              architecture: { input_modalities: ["text", "image"] },
              providers: [{ context_length: 64000, supports_tools: true }],
            },
          ],
        }),
      ),
    );

    const models = await discoverHuggingfaceModels("hf_test_token");

    expect(models).toEqual([{ ...bundledModel, contextWindow: 64000 }]);
  });

  it("limits discovered models to every available route regardless of provider order", async () => {
    const bundledModel = HUGGINGFACE_MODEL_CATALOG[0]!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            {
              id: "Qwen/Qwen3.8-2.4T-A95B",
              providers: [{ context_length: 1010000 }, { context_length: 262144 }],
            },
            {
              id: "test/reversed-provider-order",
              providers: [{ context_length: 262144 }, { context_length: 1010000 }],
            },
            {
              id: bundledModel.id,
              providers: [
                { status: "error", context_length: 16000 },
                { context_length: 96000 },
                { context_length: 0 },
                { context_length: 64000 },
              ],
            },
          ],
        }),
      ),
    );

    const models = await discoverHuggingfaceModels("hf_test_token");

    expect(models.map(({ id, contextWindow }) => ({ id, contextWindow }))).toEqual([
      { id: "Qwen/Qwen3.8-2.4T-A95B", contextWindow: 262144 },
      { id: "test/reversed-provider-order", contextWindow: 262144 },
      { id: bundledModel.id, contextWindow: 64000 },
    ]);
  });

  it("disables tools whenever an available route explicitly rejects them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            {
              id: "test/no-tools-vision",
              architecture: { input_modalities: ["text", "image"] },
              providers: [
                { context_length: 96000, supports_tools: false },
                { context_length: 64000, supports_tools: false },
              ],
            },
            {
              id: "test/mixed-routes",
              providers: [{ supports_tools: false }, { supports_tools: true }],
            },
            {
              id: "test/reversed-mixed-routes",
              providers: [{ supports_tools: true }, { supports_tools: false }],
            },
            {
              id: "test/unknown-route",
              providers: [{ supports_tools: false }, { context_length: 48000 }],
            },
            {
              id: "test/errored-route",
              providers: [
                { status: "error", context_length: 262144, supports_tools: true },
                { status: "live", context_length: 32000, supports_tools: false },
              ],
            },
            {
              id: "test/errored-unsupported-route",
              providers: [
                { status: "error", supports_tools: false },
                { status: "live", supports_tools: true },
              ],
            },
            { id: "test/no-routes" },
            { id: "test/unknown-only", providers: [{}] },
            { id: "test/tools", providers: [{ supports_tools: true }] },
          ],
        }),
      ),
    );

    const models = await discoverHuggingfaceModels("hf_test_token");

    expect(
      models.map(({ id, input, contextWindow, compat }) => ({ id, input, contextWindow, compat })),
    ).toEqual([
      {
        id: "test/no-tools-vision",
        input: ["text", "image"],
        contextWindow: 64000,
        compat: { supportsTools: false },
      },
      {
        id: "test/mixed-routes",
        input: ["text"],
        contextWindow: 131072,
        compat: { supportsTools: false },
      },
      {
        id: "test/reversed-mixed-routes",
        input: ["text"],
        contextWindow: 131072,
        compat: { supportsTools: false },
      },
      {
        id: "test/unknown-route",
        input: ["text"],
        contextWindow: 48000,
        compat: { supportsTools: false },
      },
      {
        id: "test/errored-route",
        input: ["text"],
        contextWindow: 32000,
        compat: { supportsTools: false },
      },
      {
        id: "test/errored-unsupported-route",
        input: ["text"],
        contextWindow: 131072,
        compat: undefined,
      },
      {
        id: "test/no-routes",
        input: ["text"],
        contextWindow: 131072,
        compat: undefined,
      },
      {
        id: "test/unknown-only",
        input: ["text"],
        contextWindow: 131072,
        compat: undefined,
      },
      {
        id: "test/tools",
        input: ["text"],
        contextWindow: 131072,
        compat: undefined,
      },
    ]);
  });

  it("uses the default discovery timeout for live Hugging Face fetches", async () => {
    const timeoutSpy = stubAbortSignalTimeout();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", { status: 500, headers: { "Content-Type": "application/json" } }),
      ),
    );

    await discoverHuggingfaceModels("hf_test_token");

    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it("accepts a custom discovery timeout override", async () => {
    const timeoutSpy = stubAbortSignalTimeout();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", { status: 500, headers: { "Content-Type": "application/json" } }),
      ),
    );

    await discoverHuggingfaceModels("hf_test_token", 25_000);

    expect(timeoutSpy).toHaveBeenCalledWith(25_000);
  });

  it("caps oversized live discovery timeout overrides", async () => {
    const timeoutSpy = stubAbortSignalTimeout();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", { status: 500, headers: { "Content-Type": "application/json" } }),
      ),
    );

    await discoverHuggingfaceModels("hf_test_token", Number.MAX_SAFE_INTEGER);

    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
  });

  it("cancels the response body before falling back after an HTTP error", async () => {
    stubAbortSignalTimeout();
    const response = new Response("unavailable", { status: 503 });
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    const models = await discoverHuggingfaceModels("hf_test_token");

    expect(models.map((model) => model.id)).toEqual(
      HUGGINGFACE_MODEL_CATALOG.map((model) => model.id),
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("falls back to the static catalog when the discovery response exceeds the byte cap", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const read = vi.fn(async () => ({ done: false as const, value: chunk }));
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const reader = {
      read,
      cancel,
      releaseLock,
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseFromReader(reader)),
    );

    const models = await discoverHuggingfaceModels("hf_test_token");

    expect(models.map((m) => m.id)).toEqual(HUGGINGFACE_MODEL_CATALOG.map((m) => m.id));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(5);
  });

  it("parses a valid bounded discovery response", async () => {
    const modelId = "test-org/test-model";
    const body = new TextEncoder().encode(JSON.stringify({ data: [{ id: modelId }] }));
    const read = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: body })
      .mockResolvedValueOnce({ done: true, value: undefined });
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const reader = {
      read,
      cancel,
      releaseLock,
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseFromReader(reader)),
    );

    const models = await discoverHuggingfaceModels("hf_test_token");

    expect(models.some((model) => model.id === modelId)).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  describe("isHuggingfacePolicyLocked", () => {
    it("returns true for :cheapest and :fastest refs", () => {
      expect(isHuggingfacePolicyLocked("huggingface/deepseek-ai/DeepSeek-R1:cheapest")).toBe(true);
      expect(isHuggingfacePolicyLocked("huggingface/deepseek-ai/DeepSeek-R1:fastest")).toBe(true);
    });

    it("returns false for base ref and :provider refs", () => {
      expect(isHuggingfacePolicyLocked("huggingface/deepseek-ai/DeepSeek-R1")).toBe(false);
      expect(isHuggingfacePolicyLocked("huggingface/foo:together")).toBe(false);
    });
  });
});
