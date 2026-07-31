import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { jsonResponse, requestBodyText, requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureOllamaNonInteractive } from "./setup.js";

const upsertAuthProfileWithLock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>();
  return {
    ...actual,
    upsertAuthProfileWithLock,
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: {
      url: string;
      init?: RequestInit;
      signal?: AbortSignal;
    }) => ({
      response: await globalThis.fetch(params.url, {
        ...params.init,
        ...(params.signal ? { signal: params.signal } : {}),
      }),
      finalUrl: params.url,
      release: async () => {},
    }),
  };
});

function createOllamaFetchMock(params: {
  tags: string[];
  show?: Record<string, number | undefined>;
  capabilities?: Record<string, string[] | undefined>;
  pullResponse?: Response;
}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.endsWith("/api/tags")) {
      return jsonResponse({ models: params.tags.map((name) => ({ name })) });
    }
    if (url.endsWith("/api/show")) {
      const body = JSON.parse(requestBodyText(init?.body)) as { name?: string };
      const contextWindow = body.name ? params.show?.[body.name] : undefined;
      const capabilities = body.name ? (params.capabilities?.[body.name] ?? ["tools"]) : ["tools"];
      return jsonResponse({
        ...(contextWindow ? { model_info: { "llama.context_length": contextWindow } } : {}),
        capabilities,
      });
    }
    if (url.endsWith("/api/pull")) {
      return params.pullResponse ?? new Response('{"status":"success"}\n', { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

describe("Ollama non-interactive onboarding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    upsertAuthProfileWithLock.mockClear();
  });

  it("does not persist local auth when non-interactive setup cannot select a model", async () => {
    const fetchMock = createOllamaFetchMock({
      tags: [],
      pullResponse: new Response('{"error":"disk full"}\n', { status: 200 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = createRuntime();
    const nextConfig = {};

    const result = await configureOllamaNonInteractive({
      nextConfig,
      opts: {
        customBaseUrl: "http://127.0.0.1:11434",
        customModelId: "missing-model",
      },
      runtime,
    });

    expect(runtime.error).toHaveBeenCalledWith("Download failed: disk full");
    expect(runtime.error).toHaveBeenCalledWith(
      [
        "No Ollama models are available at http://127.0.0.1:11434.",
        "Pull a model first, then re-run setup.",
      ].join("\n"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(upsertAuthProfileWithLock).not.toHaveBeenCalled();
    expect(result).toBe(nextConfig);
  });

  it("persists only installed local models when selecting a discovered custom model", async () => {
    const fetchMock = createOllamaFetchMock({ tags: ["qwen3:1.7b"] });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = createRuntime();

    const result = await configureOllamaNonInteractive({
      nextConfig: {},
      opts: {
        customBaseUrl: "http://127.0.0.1:11434",
        customModelId: "qwen3:1.7b",
      },
      runtime,
    });

    expect(result.models?.providers?.ollama?.models?.map((model) => model.id)).toEqual([
      "qwen3:1.7b",
    ]);
    expect(result.agents?.defaults?.model).toEqual({ primary: "ollama/qwen3:1.7b" });
    expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]))).not.toContain(
      "http://127.0.0.1:11434/api/pull",
    );
    expect(upsertAuthProfileWithLock).toHaveBeenCalledTimes(1);
  });

  it("keeps an installed suggested local model first in non-interactive setup", async () => {
    const fetchMock = createOllamaFetchMock({ tags: ["qwen3:1.7b", "gemma4"] });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = createRuntime();

    const result = await configureOllamaNonInteractive({
      nextConfig: {},
      opts: {
        customBaseUrl: "http://127.0.0.1:11434",
        customModelId: "qwen3:1.7b",
      },
      runtime,
    });

    expect(result.models?.providers?.ollama?.models?.map((model) => model.id)).toEqual([
      "gemma4",
      "qwen3:1.7b",
    ]);
    expect(result.agents?.defaults?.model).toEqual({ primary: "ollama/qwen3:1.7b" });
    expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]))).not.toContain(
      "http://127.0.0.1:11434/api/pull",
    );
    expect(upsertAuthProfileWithLock).toHaveBeenCalledTimes(1);
  });

  it("preserves the capabilities of an explicitly selected model beyond the discovery limit", async () => {
    const modelId = "gemma4:e2b";
    const fetchMock = createOllamaFetchMock({
      tags: [...Array.from({ length: 200 }, (_, index) => `other-${index}`), modelId],
      show: { [modelId]: 131_072 },
      capabilities: { [modelId]: ["completion", "tools", "vision", "thinking"] },
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await configureOllamaNonInteractive({
      nextConfig: {},
      opts: {
        customBaseUrl: "http://127.0.0.1:11434",
        customModelId: modelId,
      },
      runtime: createRuntime(),
    });

    expect(result.agents?.defaults?.model).toEqual({ primary: `ollama/${modelId}` });
    expect(
      result.models?.providers?.ollama?.models?.find((model) => model.id === modelId),
    ).toMatchObject({
      id: modelId,
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 131_072,
      compat: { supportsTools: true },
    });
    expect(
      fetchMock.mock.calls.filter((call) => {
        if (!requestUrl(call[0]).endsWith("/api/show")) {
          return false;
        }
        const init = call[1] as RequestInit | undefined;
        return JSON.parse(requestBodyText(init?.body)).name === modelId;
      }),
    ).toHaveLength(1);
  });

  it("preserves the discovered capabilities of a newly pulled selected model", async () => {
    const modelId = "gemma4:e2b";
    const fetchMock = createOllamaFetchMock({
      tags: [],
      show: { [modelId]: 131_072 },
      capabilities: { [modelId]: ["completion", "tools", "vision", "thinking"] },
      pullResponse: new Response('{"status":"success"}\n', { status: 200 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await configureOllamaNonInteractive({
      nextConfig: {},
      opts: {
        customBaseUrl: "http://127.0.0.1:11434",
        customModelId: modelId,
      },
      runtime: createRuntime(),
    });

    expect(result.agents?.defaults?.model).toEqual({ primary: `ollama/${modelId}` });
    expect(
      result.models?.providers?.ollama?.models?.find((model) => model.id === modelId),
    ).toMatchObject({
      id: modelId,
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 131_072,
      compat: { supportsTools: true },
    });
    expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]))).toEqual([
      "http://127.0.0.1:11434/api/tags",
      "http://127.0.0.1:11434/api/pull",
      "http://127.0.0.1:11434/api/show",
    ]);
  });
});
