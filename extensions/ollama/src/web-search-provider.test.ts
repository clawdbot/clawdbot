import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOllamaWebSearchProvider as createContractOllamaWebSearchProvider } from "../web-search-contract-api.js";
import {
  __testing as testing,
  createOllamaWebSearchProvider,
  runOllamaWebSearch,
} from "./web-search-provider.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

type OllamaProviderConfigOverride = Partial<{
  api: "ollama";
  apiKey: string;
  baseUrl: string;
  baseURL: string;
  models: NonNullable<
    NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]
  >["models"];
}>;

function createOllamaConfig(provider: OllamaProviderConfigOverride = {}): OpenClawConfig {
  return {
    models: {
      providers: {
        ollama: {
          baseUrl: "http://ollama.local:11434/v1",
          api: "ollama",
          models: [],
          ...provider,
        },
      },
    },
  };
}

function createOllamaConfigWithWebSearchBaseUrl(baseUrl: string): OpenClawConfig {
  return {
    ...createOllamaConfig(),
    plugins: {
      entries: {
        ollama: {
          config: {
            webSearch: {
              baseUrl,
            },
          },
        },
      },
    },
  };
}

function createSetupNotes() {
  const notes: Array<{ title?: string; message: string }> = [];
  return {
    notes,
    prompter: {
      note: async (message: string, title?: string) => {
        notes.push({ title, message });
      },
    },
  };
}

function expectOllamaWebSearchRequest(
  call: unknown[] | undefined,
  params: {
    url: string;
    query?: string;
    maxResults?: number;
    headers?: Record<string, string>;
    policy: Record<string, unknown>;
  },
) {
  if (!call?.[0] || typeof call[0] !== "object") {
    throw new Error("Expected fetchWithSsrFGuard call");
  }
  const request = call[0] as {
    url: string;
    init: {
      method: string;
      headers: Record<string, string>;
      body: string;
      signal: AbortSignal;
    };
    policy: Record<string, unknown>;
    auditContext: string;
  };
  expect(request).toEqual({
    url: params.url,
    init: {
      method: "POST",
      headers: params.headers ?? { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: params.query ?? "openclaw",
        max_results: params.maxResults ?? 5,
      }),
      signal: request.init.signal,
    },
    policy: params.policy,
    auditContext: "ollama-web-search.search",
  });
  expect(request.init.signal).toBeInstanceOf(AbortSignal);
}

function expectSingleSearchResultUrl(results: unknown, url: string) {
  if (!Array.isArray(results)) {
    throw new Error("Expected search results array");
  }
  expect(results).toHaveLength(1);
  const [result] = results;
  if (!result || typeof result !== "object") {
    throw new Error("Expected search result object");
  }
  expect((result as { url?: unknown }).url).toBe(url);
}

describe("ollama web search provider", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("registers a keyless web search provider", () => {
    const provider = createContractOllamaWebSearchProvider();

    expect(provider.id).toBe("ollama");
    expect(provider.label).toBe("Ollama Web Search");
    expect(provider.requiresCredential).toBe(false);
    expect(provider.envVars).toEqual([]);
  });

  it("uses the configured Ollama host and enables the plugin in config", () => {
    const provider = createOllamaWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }

    const applied = provider.applySelectionConfig({});

    expect(provider.credentialPath).toBe("");
    expect(applied.plugins?.entries?.ollama?.enabled).toBe(true);
    expect(
      testing.resolveOllamaWebSearchBaseUrl({
        models: {
          providers: {
            ollama: {
              baseUrl: "http://ollama.local:11434/v1",
              api: "ollama",
              models: [],
            },
          },
        },
      }),
    ).toBe("http://ollama.local:11434");
  });

  it("prefers the plugin web search base URL over the model provider host", () => {
    expect(
      testing.resolveOllamaWebSearchBaseUrl(
        createOllamaConfigWithWebSearchBaseUrl("http://localhost:11434/v1"),
      ),
    ).toBe("http://localhost:11434");
  });

  it("uses the configured Ollama Cloud host for web search", () => {
    expect(
      testing.resolveOllamaWebSearchBaseUrl(
        createOllamaConfig({
          baseUrl: "https://ollama.com",
        }),
      ),
    ).toBe("https://ollama.com");
  });

  it("uses the model provider baseURL alias for web search", () => {
    expect(
      testing.resolveOllamaWebSearchBaseUrl(
        createOllamaConfig({
          baseUrl: undefined,
          baseURL: "http://remote-ollama:11434/v1",
        } as OllamaProviderConfigOverride),
      ),
    ).toBe("http://remote-ollama:11434");
  });

  it("maps generic search args into the local Ollama proxy endpoint", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          results: [
            {
              title: "OpenClaw",
              url: "https://openclaw.ai/docs",
              content: "Gateway docs and setup details",
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
      release,
    });

    const provider = createOllamaWebSearchProvider();
    const tool = provider.createTool({
      config: createOllamaConfig(),
    } as never);
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const result = await tool.execute({ query: "openclaw docs", count: 3 });

    expectOllamaWebSearchRequest(fetchWithSsrFGuardMock.mock.calls[0], {
      url: "http://ollama.local:11434/api/experimental/web_search",
      query: "openclaw docs",
      maxResults: 3,
      policy: {
        allowPrivateNetwork: true,
        hostnameAllowlist: ["ollama.local"],
      },
    });
    expect(result.query).toBe("openclaw docs");
    expect(result.provider).toBe("ollama");
    expect(result.count).toBe(1);
    expectSingleSearchResultUrl(result.results, "https://openclaw.ai/docs");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("tries the future local direct endpoint when the local proxy endpoint is missing", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response("not found", { status: 404 }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            results: [{ title: "Legacy", url: "https://example.com", content: "result" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      });

    const result = await runOllamaWebSearch({
      config: createOllamaConfig(),
      query: "openclaw",
    });

    expect(result.count).toBe(1);
    expectSingleSearchResultUrl(result.results, "https://example.com");

    expect(fetchWithSsrFGuardMock.mock.calls.map((call) => call[0].url)).toEqual([
      "http://ollama.local:11434/api/experimental/web_search",
      "http://ollama.local:11434/api/web_search",
    ]);
  });

  it("uses only the hosted endpoint for Ollama Cloud base URLs", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({
          results: [{ title: "Cloud", url: "https://example.com", content: "result" }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
      release: vi.fn(async () => {}),
    });

    const result = await runOllamaWebSearch({
      config: createOllamaConfig({
        baseUrl: "https://ollama.com",
        apiKey: "cloud-config-secret",
      }),
      query: "openclaw",
    });

    expect(result.count).toBe(1);
    expect(fetchWithSsrFGuardMock.mock.calls).toHaveLength(1);
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0].url).toBe("https://ollama.com/api/web_search");
    expectOllamaWebSearchRequest(fetchWithSsrFGuardMock.mock.calls[0], {
      url: "https://ollama.com/api/web_search",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer cloud-config-secret",
      },
      policy: {
        allowPrivateNetwork: true,
        hostnameAllowlist: ["ollama.com"],
      },
    });
  });

  it("uses an env Ollama key only for the cloud fallback from a local host", async () => {
    const original = process.env.OLLAMA_API_KEY;
    try {
      process.env.OLLAMA_API_KEY = "cloud-secret";
      fetchWithSsrFGuardMock
        .mockResolvedValueOnce({
          response: new Response("not found", { status: 404 }),
          release: vi.fn(async () => {}),
        })
        .mockResolvedValueOnce({
          response: new Response("not found", { status: 404 }),
          release: vi.fn(async () => {}),
        })
        .mockResolvedValueOnce({
          response: new Response(
            JSON.stringify({
              results: [{ title: "Cloud", url: "https://example.com", content: "result" }],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
          release: vi.fn(async () => {}),
        });

      const result = await runOllamaWebSearch({
        config: createOllamaConfig(),
        query: "openclaw",
      });

      expect(result.count).toBe(1);
      const firstHeaders = fetchWithSsrFGuardMock.mock.calls[0]?.[0].init?.headers as
        | Record<string, string>
        | undefined;
      const cloudHeaders = fetchWithSsrFGuardMock.mock.calls[2]?.[0].init?.headers as
        | Record<string, string>
        | undefined;
      expect(firstHeaders?.Authorization).toBeUndefined();
      expect(cloudHeaders?.Authorization).toBe("Bearer cloud-secret");
      expect(fetchWithSsrFGuardMock.mock.calls.map((call) => call[0].url)).toEqual([
        "http://ollama.local:11434/api/experimental/web_search",
        "http://ollama.local:11434/api/web_search",
        "https://ollama.com/api/web_search",
      ]);
      expect(fetchWithSsrFGuardMock.mock.calls[2]?.[0].url).toBe(
        "https://ollama.com/api/web_search",
      );
    } finally {
      if (original === undefined) {
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = original;
      }
    }
  });

  it("surfaces Ollama signin guidance for 401 responses", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("", { status: 401 }),
      release: vi.fn(async () => {}),
    });

    await expect(runOllamaWebSearch({ query: "latest openclaw release" })).rejects.toThrow(
      "ollama signin",
    );
  });

  it("warns when Ollama is not reachable during setup without cancelling", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("connect failed"));

    const config = createOllamaConfig();
    const { notes, prompter } = createSetupNotes();

    const next = await testing.warnOllamaWebSearchPrereqs({
      config,
      prompter,
    });

    expect(next).toBe(config);
    expect(notes).toEqual([
      {
        title: "Ollama Web Search",
        message: [
          "Ollama Web Search requires Ollama to be running.",
          "Expected host: http://ollama.local:11434",
          "Start Ollama before using this provider.",
        ].join("\n"),
      },
    ]);
  });

  it("resolves env var when config apiKey is a marker string", () => {
    const original = process.env.OLLAMA_API_KEY;
    try {
      process.env.OLLAMA_API_KEY = "real-secret-from-env";
      const key = testing.resolveOllamaWebSearchApiKey(
        createOllamaConfig({
          apiKey: "OLLAMA_API_KEY",
          baseUrl: "http://localhost:11434",
        }),
      );
      expect(key).toBe("real-secret-from-env");
    } finally {
      if (original === undefined) {
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = original;
      }
    }
  });

  it("warns when ollama signin is missing during setup without cancelling", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({ error: "not signed in", signin_url: "https://ollama.com/signin" }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      });

    const config = createOllamaConfig();
    const { notes, prompter } = createSetupNotes();

    const next = await testing.warnOllamaWebSearchPrereqs({
      config,
      prompter,
    });

    expect(next).toBe(config);
    expect(notes).toEqual([
      {
        title: "Ollama Web Search",
        message: "Ollama Web Search requires `ollama signin`.\nhttps://ollama.com/signin",
      },
    ]);
  });
});
