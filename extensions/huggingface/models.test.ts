// Huggingface tests cover models plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHuggingfaceModelDefinition,
  discoverHuggingfaceModels,
  HUGGINGFACE_MODEL_CATALOG,
  isHuggingfacePolicyLocked,
} from "./api.js";
import { HUGGINGFACE_DISCOVERY_TIMEOUT_MS } from "./models.js";

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

afterEach(() => {
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

    expect(timeoutSpy).toHaveBeenCalledWith(HUGGINGFACE_DISCOVERY_TIMEOUT_MS);
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
