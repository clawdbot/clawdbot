import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
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

describe("ollama web search provider", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("registers a keyless web search provider", () => {
    expect(createContractOllamaWebSearchProvider()).toMatchObject({
      id: "ollama",
      label: "Ollama Web Search",
      requiresCredential: false,
      envVars: [],
    });
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

  it("falls back to the local Ollama host when the model provider uses ollama cloud", () => {
    expect(
      testing.resolveOllamaWebSearchBaseUrl(
        createOllamaConfig({
          baseUrl: "https://ollama.com",
        }),
      ),
    ).toBe("http://127.0.0.1:11434");
  });

  it("maps generic search args into the Ollama experimental search endpoint", async () => {
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

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://ollama.local:11434/api/experimental/web_search",
        auditContext: "ollama-web-search.search",
      }),
    );
    expect(
      JSON.parse(
        String(
          (
            fetchWithSsrFGuardMock.mock.calls[0]?.[0] as {
              init?: { body?: string };
            }
          ).init?.body,
        ),
      ),
    ).toEqual({
      query: "openclaw docs",
      max_results: 3,
    });
    expect(result).toMatchObject({
      query: "openclaw docs",
      provider: "ollama",
      count: 1,
      results: [{ url: "https://openclaw.ai/docs" }],
    });
    expect(release).toHaveBeenCalledTimes(1);
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
      expect.objectContaining({
        title: "Ollama Web Search",
        message: expect.stringContaining("requires Ollama to be running"),
      }),
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
      expect.objectContaining({
        title: "Ollama Web Search",
        message: expect.stringContaining("Ollama Web Search requires `ollama signin`."),
      }),
    ]);
    expect(notes[0]?.message).toContain("https://ollama.com/signin");
  });
});
