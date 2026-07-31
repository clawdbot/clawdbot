// Huggingface tests cover models plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHuggingfaceModelDefinition,
  discoverHuggingfaceModels,
  HUGGINGFACE_BASE_URL,
  HUGGINGFACE_MODEL_CATALOG,
  isHuggingfacePolicyLocked,
} from "./api.js";
import { normalizeHuggingfaceResolvedModel, resolveHuggingfaceRoutedModel } from "./models.js";

const ORIGINAL_VITEST = process.env.VITEST;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function restoreEnv(key: "VITEST" | "NODE_ENV", value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

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

async function clearHuggingfaceToolSupportSnapshot() {
  process.env.VITEST = "false";
  process.env.NODE_ENV = "development";
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "test/reset", providers: [] }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
  await discoverHuggingfaceModels("hf_test_token");
}

afterEach(async () => {
  await clearHuggingfaceToolSupportSnapshot();
  restoreEnv("VITEST", ORIGINAL_VITEST);
  restoreEnv("NODE_ENV", ORIGINAL_NODE_ENV);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("huggingface models", () => {
  it("buildHuggingfaceModelDefinition returns config with required fields", () => {
    const entry = expectDefined(HUGGINGFACE_MODEL_CATALOG[0], "first Hugging Face catalog model");
    const def = buildHuggingfaceModelDefinition(entry);
    expect(def.id).toBe(entry.id);
    expect(def.name).toBe(entry.name);
    expect(def.reasoning).toBe(entry.reasoning);
    expect(def.input).toEqual(entry.input);
    expect(def.cost).toEqual(entry.cost);
    expect(def.contextWindow).toBe(entry.contextWindow);
    expect(def.maxTokens).toBe(entry.maxTokens);
  });

  it("does not advertise the retired Llama 3.3 Turbo route", () => {
    expect(HUGGINGFACE_MODEL_CATALOG.map((model) => model.id)).not.toContain(
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    );
  });

  it("discoverHuggingfaceModels returns static catalog when apiKey is empty", async () => {
    const models = await discoverHuggingfaceModels("");
    expect(models).toHaveLength(HUGGINGFACE_MODEL_CATALOG.length);
    expect(models.map((m) => m.id)).toEqual(HUGGINGFACE_MODEL_CATALOG.map((m) => m.id));
  });

  it("discoverHuggingfaceModels returns static catalog in test env (VITEST)", async () => {
    const models = await discoverHuggingfaceModels("hf_test_token");
    expect(models).toHaveLength(HUGGINGFACE_MODEL_CATALOG.length);
    expect(expectDefined(models[0], "first Hugging Face model").id).toBe("deepseek-ai/DeepSeek-R1");
  });

  it("uses the default discovery timeout for live Hugging Face fetches", async () => {
    process.env.VITEST = "false";
    process.env.NODE_ENV = "development";
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
    process.env.VITEST = "false";
    process.env.NODE_ENV = "development";
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
    process.env.VITEST = "false";
    process.env.NODE_ENV = "development";
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
    process.env.VITEST = "false";
    process.env.NODE_ENV = "development";
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
    process.env.VITEST = "false";
    process.env.NODE_ENV = "development";
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
    expect(read).toHaveBeenCalledTimes(17);
  });

  it("parses a valid bounded discovery response", async () => {
    process.env.VITEST = "false";
    process.env.NODE_ENV = "development";
    const body = new TextEncoder().encode(
      JSON.stringify({
        data: [
          {
            id: "test-org/tool-model",
            providers: [
              null,
              "malformed",
              { provider: "fallback", status: "live" },
              {
                provider: "primary",
                status: "live",
                supports_tools: true,
                context_length: 65536,
              },
              {
                provider: "secondary",
                status: "live",
                supports_tools: false,
              },
            ],
          },
          {
            id: "test-org/chat-model",
            providers: [
              { provider: "fallback", status: "live" },
              { provider: "primary", status: "live", supports_tools: false },
            ],
          },
          {
            id: "test-org/unknown-model",
            providers: [{ provider: "fallback", status: "live" }],
          },
          {
            id: "test-org/no-tools-model",
            providers: [
              {
                provider: "primary",
                status: "live",
                supports_tools: false,
              },
              {
                provider: "secondary",
                status: "live",
                supports_tools: false,
              },
            ],
          },
          {
            id: "huggingface/example",
            providers: [
              {
                provider: "no-tools-provider",
                status: "live",
                supports_tools: false,
              },
            ],
          },
          {
            id: "Qwen/Qwen3.5-9B",
            providers: [
              {
                provider: "primary",
                status: "live",
                supports_tools: true,
                context_length: 262144,
              },
              {
                provider: "no-tools",
                status: "live",
                supports_tools: false,
              },
            ],
          },
          {
            id: "Qwen/Qwen3-4B-Instruct-2507",
            providers: [{ provider: "primary", status: "live", supports_tools: true }],
          },
          {
            id: "Qwen/Qwen3-4B-Thinking-2507",
            providers: [{ provider: "primary", status: "live", supports_tools: true }],
          },
        ],
      }),
    );
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

    expect(models.find((model) => model.id === "test-org/tool-model")?.compat).toBeUndefined();
    expect(models.find((model) => model.id === "test-org/tool-model")?.contextWindow).toBe(65536);
    expect(models.find((model) => model.id === "test-org/chat-model")?.compat).toBeUndefined();
    expect(models.find((model) => model.id === "test-org/unknown-model")?.compat).toBeUndefined();
    expect(models.find((model) => model.id === "test-org/no-tools-model")?.compat).toBeUndefined();
    expect(models.find((model) => model.id === "Qwen/Qwen3.5-9B")).toMatchObject({
      reasoning: true,
      compat: {
        thinkingFormat: "qwen-chat-template",
      },
    });
    expect(models.find((model) => model.id === "Qwen/Qwen3-4B-Instruct-2507")).toMatchObject({
      reasoning: false,
    });
    const thinkingOnlyModel = models.find((model) => model.id === "Qwen/Qwen3-4B-Thinking-2507");
    expect(thinkingOnlyModel?.reasoning).toBe(true);
    expect(thinkingOnlyModel?.compat).toBeUndefined();

    const baseModel = { id: "test-org/chat-model" } as never;
    expect(normalizeHuggingfaceResolvedModel("test-org/chat-model", baseModel)).toBeUndefined();
    expect(
      normalizeHuggingfaceResolvedModel("test-org/chat-model:primary", baseModel),
    ).toMatchObject({
      compat: { supportsTools: false },
    });
    expect(
      normalizeHuggingfaceResolvedModel("test-org/tool-model:primary", baseModel),
    ).toBeUndefined();
    expect(
      normalizeHuggingfaceResolvedModel("test-org/tool-model:secondary", baseModel),
    ).toMatchObject({
      compat: { supportsTools: false },
    });
    expect(
      normalizeHuggingfaceResolvedModel("test-org/chat-model:unknown", baseModel),
    ).toBeUndefined();
    for (const suffix of ["cheapest", "fastest", "preferred"]) {
      expect(
        normalizeHuggingfaceResolvedModel(`test-org/chat-model:${suffix}`, baseModel),
      ).toBeUndefined();
      expect(
        normalizeHuggingfaceResolvedModel(`test-org/no-tools-model:${suffix}`, baseModel),
      ).toMatchObject({
        compat: { supportsTools: false },
      });
    }
    expect(normalizeHuggingfaceResolvedModel("test-org/no-tools-model", baseModel)).toMatchObject({
      compat: { supportsTools: false },
    });
    expect(
      normalizeHuggingfaceResolvedModel("huggingface/example:no-tools-provider", baseModel),
    ).toMatchObject({
      compat: { supportsTools: false },
    });
    expect(
      normalizeHuggingfaceResolvedModel("test-org/chat-model:primary", {
        id: "test-org/chat-model:primary",
        compat: { supportsTools: true },
      } as never),
    ).toMatchObject({
      compat: { supportsTools: false },
    });
    expect(
      normalizeHuggingfaceResolvedModel("test-org/chat-model:primary", {
        id: "test-org/chat-model:primary",
        compat: { supportsTools: false },
      } as never),
    ).toBeUndefined();
    expect(
      normalizeHuggingfaceResolvedModel("Qwen/Qwen3.5-9B:no-tools", {
        id: "Qwen/Qwen3.5-9B:no-tools",
        compat: { thinkingFormat: "qwen-chat-template" },
      } as never),
    ).toMatchObject({
      compat: {
        supportsTools: false,
        thinkingFormat: "qwen-chat-template",
      },
    });
    const catalogModel = expectDefined(
      models.find((model) => model.id === "Qwen/Qwen3.5-9B"),
      "discovered Qwen route model",
    );
    const modelRegistry = {
      find: vi.fn((_provider: string, modelId: string) =>
        modelId === "Qwen/Qwen3.5-9B"
          ? {
              ...catalogModel,
              provider: "huggingface",
              api: "openai-completions",
              baseUrl: HUGGINGFACE_BASE_URL,
            }
          : undefined,
      ),
      getAll: vi.fn(() => []),
    } as never;
    expect(
      resolveHuggingfaceRoutedModel({
        provider: "huggingface",
        modelId: "Qwen/Qwen3.5-9B:primary",
        modelRegistry,
      } as never),
    ).toMatchObject({
      id: "Qwen/Qwen3.5-9B:primary",
      provider: "huggingface",
      compat: { thinkingFormat: "qwen-chat-template" },
    });
    expect(
      resolveHuggingfaceRoutedModel({
        provider: "huggingface",
        modelId: "Qwen/Qwen3.5-9B:preferred",
        modelRegistry,
      } as never),
    ).toMatchObject({
      id: "Qwen/Qwen3.5-9B:preferred",
      provider: "huggingface",
    });
    expect(
      resolveHuggingfaceRoutedModel({
        provider: "huggingface",
        modelId: "Qwen/Qwen3.5-9B:unknown",
        modelRegistry,
      } as never),
    ).toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("keeps the last successful route capability snapshot after discovery fails", async () => {
    process.env.VITEST = "false";
    process.env.NODE_ENV = "development";
    const successfulResponse = new Response(
      JSON.stringify({
        data: [
          {
            id: "test-org/chat-model",
            providers: [
              {
                provider: "primary",
                status: "live",
                supports_tools: false,
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(successfulResponse)
        .mockResolvedValueOnce(
          new Response("unavailable", {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }),
        ),
    );

    await discoverHuggingfaceModels("hf_test_token");
    await discoverHuggingfaceModels("hf_test_token");

    expect(
      normalizeHuggingfaceResolvedModel("test-org/chat-model:primary", {
        id: "test-org/chat-model:primary",
      } as never),
    ).toMatchObject({
      compat: { supportsTools: false },
    });
  });

  it("clears stale route capabilities after successful empty discovery", async () => {
    process.env.VITEST = "false";
    process.env.NODE_ENV = "development";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "test-org/chat-model",
                  providers: [
                    {
                      provider: "primary",
                      status: "live",
                      supports_tools: false,
                    },
                  ],
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
    );

    await discoverHuggingfaceModels("hf_test_token");
    await discoverHuggingfaceModels("hf_test_token");

    const baseModel = {
      id: "test-org/chat-model",
      provider: "huggingface",
    } as never;
    expect(
      normalizeHuggingfaceResolvedModel("test-org/chat-model:primary", baseModel),
    ).toBeUndefined();
    expect(
      resolveHuggingfaceRoutedModel({
        provider: "huggingface",
        modelId: "test-org/chat-model:primary",
        modelRegistry: {
          find: vi.fn(() => baseModel),
          getAll: vi.fn(() => []),
        },
      } as never),
    ).toBeUndefined();
  });

  describe("isHuggingfacePolicyLocked", () => {
    it("returns true for router policy refs", () => {
      expect(isHuggingfacePolicyLocked("huggingface/deepseek-ai/DeepSeek-R1:cheapest")).toBe(true);
      expect(isHuggingfacePolicyLocked("huggingface/deepseek-ai/DeepSeek-R1:fastest")).toBe(true);
      expect(isHuggingfacePolicyLocked("huggingface/deepseek-ai/DeepSeek-R1:preferred")).toBe(true);
    });

    it("returns false for base ref and :provider refs", () => {
      expect(isHuggingfacePolicyLocked("huggingface/deepseek-ai/DeepSeek-R1")).toBe(false);
      expect(isHuggingfacePolicyLocked("huggingface/foo:together")).toBe(false);
    });
  });
});
