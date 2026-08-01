// Ollama tests cover web search provider plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SecretInput } from "openclaw/plugin-sdk/secret-input";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../../test-support/streaming-error-response.js";
import { createOllamaWebSearchProvider as createContractOllamaWebSearchProvider } from "../web-search-contract-api.js";
import { createOllamaWebSearchProvider } from "./web-search-provider.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

type OllamaProviderConfigOverride = Partial<{
  api: "ollama";
  apiKey: SecretInput;
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

function mockSuccessfulSearchResponse() {
  fetchWithSsrFGuardMock.mockResolvedValue({
    response: new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    release: vi.fn(async () => {}),
  });
}

async function runOllamaWebSearchSetup(config: OpenClawConfig) {
  const provider = createOllamaWebSearchProvider();
  if (!provider.runSetup) {
    throw new Error("Expected Ollama web search setup");
  }
  const { notes, prompter } = createSetupNotes();
  const next = await provider.runSetup({ config, prompter } as never);
  return { next, notes };
}

async function runOllamaWebSearch(params: {
  config?: OpenClawConfig;
  query: string;
  count?: number;
}): Promise<Record<string, unknown>> {
  const tool = createOllamaWebSearchProvider().createTool({
    config: params.config ?? {},
  } as never);
  if (!tool) {
    throw new Error("Expected Ollama web search tool");
  }
  return await tool.execute({
    query: params.query,
    ...(params.count === undefined ? {} : { count: params.count }),
  });
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
      signal?: AbortSignal;
    };
    timeoutMs?: number;
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
    },
    timeoutMs: 15_000,
    policy: params.policy,
    auditContext: "ollama-web-search.search",
  });
  // The deadline must be guard-owned so it also bounds DNS/proxy preflight.
  expect(request.init.signal).toBeUndefined();
}

function fetchCall(index = 0): unknown[] {
  const call = fetchWithSsrFGuardMock.mock.calls.at(index);
  if (!call) {
    throw new Error(`expected guarded fetch call ${index}`);
  }
  return call;
}

function fetchRequest(index = 0): {
  init?: { headers?: Record<string, string> };
  url?: string;
} {
  const request = fetchCall(index).at(0);
  if (!request || typeof request !== "object") {
    throw new Error(`expected guarded fetch request ${index}`);
  }
  return request as {
    init?: { headers?: Record<string, string> };
    url?: string;
  };
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

async function expectConfiguredRefFailure(input: SecretInput, message: string) {
  await expect(
    runOllamaWebSearch({
      config: createOllamaConfig({ apiKey: input }),
      query: "openclaw",
    }),
  ).rejects.toThrow(message);
  expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
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

  it("uses the configured Ollama host and enables the plugin in config", async () => {
    const provider = createOllamaWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }

    const applied = provider.applySelectionConfig({});

    expect(provider.credentialPath).toBe("");
    expect(applied.plugins?.entries?.ollama?.enabled).toBe(true);
    mockSuccessfulSearchResponse();
    await runOllamaWebSearch({ config: createOllamaConfig(), query: "openclaw" });
    expect(fetchRequest().url).toBe("http://ollama.local:11434/api/experimental/web_search");
  });

  it("prefers the plugin web search base URL over the model provider host", async () => {
    mockSuccessfulSearchResponse();
    await runOllamaWebSearch({
      config: createOllamaConfigWithWebSearchBaseUrl("http://localhost:11434/v1"),
      query: "openclaw",
    });
    expect(fetchRequest().url).toBe("http://localhost:11434/api/experimental/web_search");
  });

  it("uses the configured Ollama Cloud host for web search", async () => {
    mockSuccessfulSearchResponse();
    await runOllamaWebSearch({
      config: createOllamaConfig({ baseUrl: "https://ollama.com" }),
      query: "openclaw",
    });
    expect(fetchRequest().url).toBe("https://ollama.com/api/web_search");
  });

  it("uses the model provider baseURL alias for web search", async () => {
    mockSuccessfulSearchResponse();
    await runOllamaWebSearch({
      config: createOllamaConfig({
        baseUrl: undefined,
        baseURL: "http://remote-ollama:11434/v1",
      } as OllamaProviderConfigOverride),
      query: "openclaw",
    });
    expect(fetchRequest().url).toBe("http://remote-ollama:11434/api/experimental/web_search");
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

    expectOllamaWebSearchRequest(fetchCall(), {
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
    expect(fetchRequest().url).toBe("https://ollama.com/api/web_search");
    expectOllamaWebSearchRequest(fetchCall(), {
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
      const firstHeaders = fetchRequest().init?.headers;
      const cloudHeaders = fetchRequest(2).init?.headers;
      expect(firstHeaders?.Authorization).toBeUndefined();
      expect(cloudHeaders?.Authorization).toBe("Bearer cloud-secret");
      expect(fetchWithSsrFGuardMock.mock.calls.map((call) => call[0].url)).toEqual([
        "http://ollama.local:11434/api/experimental/web_search",
        "http://ollama.local:11434/api/web_search",
        "https://ollama.com/api/web_search",
      ]);
      expect(fetchRequest(2).url).toBe("https://ollama.com/api/web_search");
    } finally {
      if (original === undefined) {
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = original;
      }
    }
  });

  it.each<SecretInput>([
    {
      source: "env",
      provider: "default",
      id: "OLLAMA_WEB_SEARCH_REF",
    },
    "$OLLAMA_WEB_SEARCH_REF",
    "${OLLAMA_WEB_SEARCH_REF}",
  ])("resolves provider apiKey env SecretRef %# for web search requests", async (apiKey) => {
    const refEnvVar = "OLLAMA_WEB_SEARCH_REF";
    const resolvedKey = "resolved-ref-value";
    await withEnvAsync({ [refEnvVar]: resolvedKey }, async () => {
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
          apiKey,
        }),
        query: "openclaw",
      });

      expect(result.count).toBe(1);
      expectOllamaWebSearchRequest(fetchCall(), {
        url: "https://ollama.com/api/web_search",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resolvedKey}`,
        },
        policy: {
          allowPrivateNetwork: true,
          hostnameAllowlist: ["ollama.com"],
        },
      });
    });
  });

  it("keeps the ambient cloud fallback when a configured selected-host key is also set", async () => {
    // Regression guard (mixed credentials): a configured selected-host key must not suppress the
    // separate ambient OLLAMA_API_KEY used for the final Ollama Cloud attempt after the two
    // selected-host attempts fail.
    const ambientEnvVar = ["OLLAMA_API", "KEY"].join("_");
    await withEnvAsync({ [ambientEnvVar]: "ambient-cloud-key" }, async () => {
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
        config: createOllamaConfig({ apiKey: "configured-host-key" }),
        query: "openclaw",
      });

      expect(result.count).toBe(1);
      expect(fetchWithSsrFGuardMock.mock.calls.map((call) => call[0].url)).toEqual([
        "http://ollama.local:11434/api/experimental/web_search",
        "http://ollama.local:11434/api/web_search",
        "https://ollama.com/api/web_search",
      ]);
      // Selected-host attempts carry the configured key; the cloud fallback carries the ambient key.
      expect(fetchRequest(0).init?.headers?.Authorization).toBe("Bearer configured-host-key");
      expect(fetchRequest(1).init?.headers?.Authorization).toBe("Bearer configured-host-key");
      expect(fetchRequest(2).init?.headers?.Authorization).toBe("Bearer ambient-cloud-key");
    });
  });

  it("does not use ambient env fallback when a configured apiKey SecretRef is unavailable", async () => {
    const refEnvVar = "OLLAMA_WEB_SEARCH_REF";
    const ambientEnvVar = ["OLLAMA_API", "KEY"].join("_");
    const ambientKey = ["ambient", "cloud", "value"].join("-");
    await withEnvAsync({ [refEnvVar]: undefined, [ambientEnvVar]: ambientKey }, async () => {
      await expectConfiguredRefFailure(
        {
          source: "env",
          provider: "default",
          id: refEnvVar,
        },
        "models.providers.ollama.apiKey env SecretRef OLLAMA_WEB_SEARCH_REF is not available",
      );
    });
  });

  it.each(["$OLLAMA_WEB_SEARCH_REF", "${OLLAMA_WEB_SEARCH_REF}"])(
    "does not use ambient env fallback when configured apiKey SecretRef shorthand %s is unavailable",
    async (apiKey) => {
      const refEnvVar = "OLLAMA_WEB_SEARCH_REF";
      const ambientEnvVar = ["OLLAMA_API", "KEY"].join("_");
      const ambientKey = ["ambient", "cloud", "value"].join("-");
      await withEnvAsync({ [refEnvVar]: undefined, [ambientEnvVar]: ambientKey }, async () => {
        await expectConfiguredRefFailure(
          apiKey,
          "models.providers.ollama.apiKey env SecretRef OLLAMA_WEB_SEARCH_REF is not available",
        );
      });
    },
  );

  it("does not use ambient env fallback for non-env apiKey SecretRefs", async () => {
    const ambientEnvVar = ["OLLAMA_API", "KEY"].join("_");
    const ambientKey = ["ambient", "cloud", "value"].join("-");
    await withEnvAsync({ [ambientEnvVar]: ambientKey }, async () => {
      await expectConfiguredRefFailure(
        {
          source: "file",
          provider: "vault",
          id: "/providers/ollama/web-search",
        },
        "models.providers.ollama.apiKey SecretRef cannot be resolved by Ollama web search",
      );
    });
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

  it("reports malformed Ollama web search JSON with a stable provider error", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response("{ nope", { status: 200 }),
      release: vi.fn(async () => {}),
    });

    await expect(
      runOllamaWebSearch({
        config: createOllamaConfig(),
        query: "openclaw",
      }),
    ).rejects.toThrow("Ollama web search: malformed JSON response");
  });

  it("bounds successful Ollama web search JSON bodies before parsing", async () => {
    const streamed = createStreamingResponse({
      chunkCount: 32,
      chunkSize: 1024 * 1024,
      text: "x",
      headers: { "content-type": "application/json" },
    });
    const jsonSpy = vi.spyOn(streamed.response, "json").mockRejectedValue(new Error("unbounded"));
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: streamed.response,
      release: vi.fn(async () => {}),
    });

    await expect(
      runOllamaWebSearch({
        config: createOllamaConfig(),
        query: "openclaw",
      }),
    ).rejects.toThrow("Ollama web search: JSON response exceeds 16777216 bytes");

    expect(streamed.getReadCount()).toBeLessThan(32);
    expect(streamed.wasCanceled()).toBe(true);
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it("warns when Ollama is not reachable during setup without cancelling", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("connect failed"));

    const config = createOllamaConfig();
    const { next, notes } = await runOllamaWebSearchSetup(config);

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

  it("resolves env var when config apiKey is a marker string", async () => {
    const original = process.env.OLLAMA_API_KEY;
    try {
      process.env.OLLAMA_API_KEY = "real-secret-from-env";
      mockSuccessfulSearchResponse();
      await runOllamaWebSearch({
        config: createOllamaConfig({
          apiKey: "OLLAMA_API_KEY",
          baseUrl: "https://ollama.com",
        }),
        query: "openclaw",
      });
      expect(fetchRequest().init?.headers?.Authorization).toBe("Bearer real-secret-from-env");
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
    const { next, notes } = await runOllamaWebSearchSetup(config);

    expect(next).toBe(config);
    expect(notes).toEqual([
      {
        title: "Ollama Web Search",
        message: "Ollama Web Search requires `ollama signin`.\nhttps://ollama.com/signin",
      },
    ]);
  });
});
