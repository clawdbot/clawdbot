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
  tagModels?: Array<{ name: string; size?: number }>;
  show?: Record<string, number | undefined>;
  capabilities?: Record<string, string[] | undefined>;
  pullResponse?: Response;
}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.endsWith("/api/tags")) {
      return jsonResponse({
        models: params.tagModels ?? params.tags.map((name) => ({ name })),
      });
    }
    if (url.endsWith("/api/show")) {
      const body = JSON.parse(requestBodyText(init?.body)) as { model?: string };
      const contextWindow = body.model ? params.show?.[body.model] : undefined;
      const capabilities = body.model
        ? (params.capabilities?.[body.model] ?? ["tools"])
        : ["tools"];
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

  it.each([
    {
      label: "Ollama reports a pull failure",
      body: '{"error":"disk full"}\n',
      error: "Download failed: disk full",
    },
    {
      label: "the model pull ends before success",
      body: '{"status":"pulling manifest"}\n',
      error: "Failed to download missing-model: pull stream ended before success",
    },
  ])("does not persist unavailable local models when $label", async ({ body, error }) => {
    const fetchMock = createOllamaFetchMock({
      tags: [],
      pullResponse: new Response(body, { status: 200 }),
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

    expect(runtime.error).toHaveBeenCalledWith(error);
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
    expect(result.models?.providers?.ollama?.apiKey).toBe("ollama-local");
    expect(upsertAuthProfileWithLock).not.toHaveBeenCalled();
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
    expect(result.models?.providers?.ollama?.apiKey).toBe("ollama-local");
    expect(upsertAuthProfileWithLock).not.toHaveBeenCalled();
  });

  it("uses the smallest capable discovered model as the non-interactive default", async () => {
    const fetchMock = createOllamaFetchMock({
      tags: [],
      tagModels: [
        { name: "qwen3:4b-instruct", size: 2_497_293_803 },
        { name: "gemma4:latest", size: 9_608_350_718 },
        { name: "llama3.2:latest", size: 2_019_393_189 },
      ],
      show: {
        "qwen3:4b-instruct": 262_144,
        "gemma4:latest": 131_072,
        "llama3.2:latest": 131_072,
      },
      capabilities: {
        "qwen3:4b-instruct": ["completion", "tools", "thinking"],
        "gemma4:latest": ["completion", "tools", "thinking"],
        "llama3.2:latest": ["completion", "tools"],
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = createRuntime();

    const result = await configureOllamaNonInteractive({
      nextConfig: {},
      opts: { customBaseUrl: "http://127.0.0.1:11434" },
      runtime,
    });

    expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]))).not.toContain(
      "http://127.0.0.1:11434/api/pull",
    );
    expect(result.agents?.defaults?.model).toEqual({ primary: "ollama/llama3.2:latest" });
    expect(runtime.log).toHaveBeenCalledWith("Default Ollama model: llama3.2:latest");
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
        return JSON.parse(requestBodyText(init?.body)).model === modelId;
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
