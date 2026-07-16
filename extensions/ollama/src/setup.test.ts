import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, requestBodyText, requestUrl } from "../../../src/test-helpers/http.js";
import {
  configureOllamaNonInteractive,
  ensureOllamaModelPulled,
  promptAndConfigureOllama,
} from "./setup.js";

const upsertAuthProfileWithLock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../src/agents/auth-profiles.js", () => ({
  upsertAuthProfileWithLock,
}));

function createOllamaFetchMock(params: {
  tags?: string[];
  show?: Record<string, number | undefined>;
  meResponses?: Response[];
  pullResponse?: Response;
  tagsError?: Error;
}) {
  const meResponses = [...(params.meResponses ?? [])];
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.endsWith("/api/tags")) {
      if (params.tagsError) {
        throw params.tagsError;
      }
      return jsonResponse({ models: (params.tags ?? []).map((name) => ({ name })) });
    }
    if (url.endsWith("/api/show")) {
      const body = JSON.parse(requestBodyText(init?.body)) as { name?: string };
      const contextWindow = body.name ? params.show?.[body.name] : undefined;
      return contextWindow
        ? jsonResponse({ model_info: { "llama.context_length": contextWindow } })
        : jsonResponse({});
    }
    if (url.endsWith("/api/me")) {
      return meResponses.shift() ?? jsonResponse({ username: "testuser" });
    }
    if (url.endsWith("/api/pull")) {
      return params.pullResponse ?? new Response('{"status":"success"}\n', { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function createModePrompter(
  mode: "local" | "remote",
  params?: { confirm?: boolean },
): WizardPrompter {
  return {
    text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
    select: vi.fn().mockResolvedValueOnce(mode),
    ...(params?.confirm !== undefined
      ? { confirm: vi.fn().mockResolvedValueOnce(params.confirm) }
      : {}),
    note: vi.fn(async () => undefined),
  } as unknown as WizardPrompter;
}

function createSignedOutRemoteFetchMock() {
  return createOllamaFetchMock({
    tags: ["llama3:8b"],
    meResponses: [
      jsonResponse({ error: "not signed in", signin_url: "https://ollama.com/signin" }, 401),
      jsonResponse({ username: "testuser" }),
    ],
  });
}

function createDefaultOllamaConfig(primary: string) {
  return {
    agents: { defaults: { model: { primary } } },
    models: { providers: { ollama: { baseUrl: "http://127.0.0.1:11434", models: [] } } },
  };
}

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

describe("ollama setup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    upsertAuthProfileWithLock.mockClear();
  });

  it("puts suggested local model first in local mode", async () => {
    const prompter = createModePrompter("local");

    const fetchMock = createOllamaFetchMock({ tags: ["llama3:8b"] });
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({
      cfg: {},
      prompter,
      isRemote: false,
      openUrl: vi.fn(async () => undefined),
    });
    const modelIds = result.config.models?.providers?.ollama?.models?.map((m) => m.id);

    expect(modelIds?.[0]).toBe("gemma4");
  });

  it("puts suggested cloud model first in remote mode", async () => {
    const prompter = createModePrompter("remote");

    const fetchMock = createOllamaFetchMock({ tags: ["llama3:8b"] });
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({
      cfg: {},
      prompter,
      isRemote: false,
      openUrl: vi.fn(async () => undefined),
    });
    const modelIds = result.config.models?.providers?.ollama?.models?.map((m) => m.id);

    expect(modelIds?.[0]).toBe("kimi-k2.5:cloud");
  });

  it("mode selection affects model ordering (local)", async () => {
    const prompter = createModePrompter("local");

    const fetchMock = createOllamaFetchMock({ tags: ["llama3:8b", "gemma4"] });
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({
      cfg: {},
      prompter,
      isRemote: false,
      openUrl: vi.fn(async () => undefined),
    });

    const modelIds = result.config.models?.providers?.ollama?.models?.map((m) => m.id);
    expect(modelIds?.[0]).toBe("gemma4");
    expect(modelIds).toContain("llama3:8b");
  });

  it("cloud+local mode triggers /api/me check and opens sign-in URL", async () => {
    const prompter = createModePrompter("remote", { confirm: true });
    const fetchMock = createSignedOutRemoteFetchMock();
    const openUrl = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);

    await promptAndConfigureOllama({ cfg: {}, prompter, isRemote: false, openUrl });

    expect(openUrl).toHaveBeenCalledWith("https://ollama.com/signin");
    expect(prompter.confirm).toHaveBeenCalled();
  });

  it("cloud+local mode does not open browser in remote environment", async () => {
    const prompter = createModePrompter("remote", { confirm: true });
    const fetchMock = createSignedOutRemoteFetchMock();
    const openUrl = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);

    await promptAndConfigureOllama({ cfg: {}, prompter, isRemote: true, openUrl });

    expect(openUrl).not.toHaveBeenCalled();
  });

  it("local mode does not trigger cloud auth", async () => {
    const prompter = createModePrompter("local");

    const fetchMock = createOllamaFetchMock({ tags: ["llama3:8b"] });
    vi.stubGlobal("fetch", fetchMock);

    await promptAndConfigureOllama({
      cfg: {},
      prompter,
      isRemote: false,
      openUrl: vi.fn(async () => undefined),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/tags");
    expect(fetchMock.mock.calls.some((call) => requestUrl(call[0]).includes("/api/me"))).toBe(
      false,
    );
  });

  it("suggested models appear first in model list (cloud+local)", async () => {
    const prompter = {
      text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
      select: vi.fn().mockResolvedValueOnce("remote"),
      note: vi.fn(async () => undefined),
    } as unknown as WizardPrompter;

    const fetchMock = createOllamaFetchMock({
      tags: ["llama3:8b", "gemma4", "deepseek-r1:14b"],
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({
      cfg: {},
      prompter,
      isRemote: false,
      openUrl: vi.fn(async () => undefined),
    });
    const models = result.config.models?.providers?.ollama?.models;
    const modelIds = models?.map((m) => m.id);

    expect(modelIds).toEqual([
      "kimi-k2.5:cloud",
      "minimax-m2.7:cloud",
      "glm-5.1:cloud",
      "llama3:8b",
      "gemma4",
      "deepseek-r1:14b",
    ]);
    expect(models?.find((model) => model.id === "kimi-k2.5:cloud")?.input).toEqual([
      "text",
      "image",
    ]);
  });

  it("uses /api/show context windows when building Ollama model configs", async () => {
    const prompter = {
      text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
      select: vi.fn().mockResolvedValueOnce("local"),
      note: vi.fn(async () => undefined),
    } as unknown as WizardPrompter;

    const fetchMock = createOllamaFetchMock({
      tags: ["llama3:8b"],
      show: { "llama3:8b": 65536 },
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({
      cfg: {},
      prompter,
      isRemote: false,
      openUrl: vi.fn(async () => undefined),
    });
    const model = result.config.models?.providers?.ollama?.models?.find(
      (m) => m.id === "llama3:8b",
    );

    expect(model?.contextWindow).toBe(65536);
  });

  describe("ensureOllamaModelPulled", () => {
    it("pulls model when not available locally", async () => {
      const progress = { update: vi.fn(), stop: vi.fn() };
      const prompter = {
        progress: vi.fn(() => progress),
      } as unknown as WizardPrompter;

      const fetchMock = createOllamaFetchMock({
        tags: ["llama3:8b"],
        pullResponse: new Response('{"status":"success"}\n', { status: 200 }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureOllamaModelPulled({
        config: createDefaultOllamaConfig("ollama/gemma4"),
        model: "ollama/gemma4",
        prompter,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toContain("/api/pull");
    });

    it("skips pull when model is already available", async () => {
      const prompter = {} as unknown as WizardPrompter;

      const fetchMock = createOllamaFetchMock({ tags: ["gemma4"] });
      vi.stubGlobal("fetch", fetchMock);

      await ensureOllamaModelPulled({
        config: createDefaultOllamaConfig("ollama/gemma4"),
        model: "ollama/gemma4",
        prompter,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("skips pull for cloud models", async () => {
      const prompter = {} as unknown as WizardPrompter;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await ensureOllamaModelPulled({
        config: createDefaultOllamaConfig("ollama/kimi-k2.5:cloud"),
        model: "ollama/kimi-k2.5:cloud",
        prompter,
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("skips when model is not an ollama model", async () => {
      const prompter = {} as unknown as WizardPrompter;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await ensureOllamaModelPulled({
        config: {
          agents: { defaults: { model: { primary: "openai/gpt-4o" } } },
        },
        model: "openai/gpt-4o",
        prompter,
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("uses discovered model when requested non-interactive download fails", async () => {
    const fetchMock = createOllamaFetchMock({
      tags: ["qwen2.5-coder:7b"],
      pullResponse: new Response('{"error":"disk full"}\n', { status: 200 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = createRuntime();

    const result = await configureOllamaNonInteractive({
      nextConfig: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-4o-mini",
              fallbacks: ["anthropic/claude-sonnet-4-5"],
            },
          },
        },
      },
      opts: {
        customBaseUrl: "http://127.0.0.1:11434",
        customModelId: "missing-model",
      },
      runtime,
    });

    expect(runtime.error).toHaveBeenCalledWith("Download failed: disk full");
    expect(result.agents?.defaults?.model).toEqual({
      primary: "ollama/qwen2.5-coder:7b",
      fallbacks: ["anthropic/claude-sonnet-4-5"],
    });
  });

  it("normalizes ollama/ prefix in non-interactive custom model download", async () => {
    const fetchMock = createOllamaFetchMock({
      tags: [],
      pullResponse: new Response('{"status":"success"}\n', { status: 200 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = createRuntime();

    const result = await configureOllamaNonInteractive({
      nextConfig: {},
      opts: {
        customBaseUrl: "http://127.0.0.1:11434",
        customModelId: "ollama/llama3.2:latest",
      },
      runtime,
    });

    const pullRequest = fetchMock.mock.calls[1]?.[1];
    expect(JSON.parse(requestBodyText(pullRequest?.body))).toEqual({ name: "llama3.2:latest" });
    expect(result.agents?.defaults?.model).toEqual(
      expect.objectContaining({ primary: "ollama/llama3.2:latest" }),
    );
  });

  it("accepts cloud models in non-interactive mode without pulling", async () => {
    const fetchMock = createOllamaFetchMock({ tags: [] });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = createRuntime();

    const result = await configureOllamaNonInteractive({
      nextConfig: {},
      opts: {
        customBaseUrl: "http://127.0.0.1:11434",
        customModelId: "kimi-k2.5:cloud",
      },
      runtime,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.models?.providers?.ollama?.models?.map((model) => model.id)).toContain(
      "kimi-k2.5:cloud",
    );
    expect(result.agents?.defaults?.model).toEqual(
      expect.objectContaining({ primary: "ollama/kimi-k2.5:cloud" }),
    );
  });

  it("exits when Ollama is unreachable", async () => {
    const fetchMock = createOllamaFetchMock({
      tagsError: new Error("connect ECONNREFUSED"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as unknown as RuntimeEnv;
    const nextConfig = {};

    const result = await configureOllamaNonInteractive({
      nextConfig,
      opts: {
        customBaseUrl: "http://127.0.0.1:11435",
        customModelId: "llama3.2:latest",
      },
      runtime,
    });

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Ollama could not be reached at http://127.0.0.1:11435."),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(result).toBe(nextConfig);
  });
});
