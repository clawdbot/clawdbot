import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const ensureLmstudioModelLoadedMock = vi.hoisted(() => vi.fn());
const resolveLmstudioRuntimeApiKeyMock = vi.hoisted(() => vi.fn());

vi.mock("../../plugin-sdk/lmstudio-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugin-sdk/lmstudio-runtime.js")>();
  return {
    ...actual,
    ensureLmstudioModelLoaded: (...args: unknown[]) => ensureLmstudioModelLoadedMock(...args),
    resolveLmstudioRuntimeApiKey: (...args: unknown[]) => resolveLmstudioRuntimeApiKeyMock(...args),
  };
});

let createLmstudioEmbeddingProvider: typeof import("./embeddings-lmstudio.js").createLmstudioEmbeddingProvider;

describe("embeddings-lmstudio", () => {
  const originalFetch = globalThis.fetch;
  const jsonResponse = (embedding: number[]) =>
    new Response(
      JSON.stringify({
        data: [{ embedding }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );

  function mockEmbeddingFetch(embedding: number[]) {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(jsonResponse(embedding));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  beforeEach(async () => {
    vi.resetModules();
    ({ createLmstudioEmbeddingProvider } = await import("./embeddings-lmstudio.js"));
    ensureLmstudioModelLoadedMock.mockReset();
    resolveLmstudioRuntimeApiKeyMock.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("embeds against inference base and warms model with resolved key", async () => {
    ensureLmstudioModelLoadedMock.mockResolvedValue(undefined);
    resolveLmstudioRuntimeApiKeyMock.mockResolvedValue("profile-lmstudio-key");

    const fetchMock = mockEmbeddingFetch([0.1, 0.2]);

    const { provider } = await createLmstudioEmbeddingProvider({
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://localhost:1234/api/v1/",
              headers: { "X-Provider": "provider" },
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      provider: "lmstudio",
      model: "lmstudio/text-embedding-nomic-embed-text-v1.5",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:1234/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer profile-lmstudio-key",
          "X-Provider": "provider",
        }),
      }),
    );
    expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "profile-lmstudio-key",
      headers: {
        "X-Provider": "provider",
      },
      ssrfPolicy: { allowedHostnames: ["localhost"] },
      modelKey: "text-embedding-nomic-embed-text-v1.5",
      timeoutMs: 120_000,
    });
  });

  it("uses memorySearch remote overrides for primary lmstudio", async () => {
    ensureLmstudioModelLoadedMock.mockResolvedValue(undefined);
    resolveLmstudioRuntimeApiKeyMock.mockResolvedValue("profile-key");

    const fetchMock = mockEmbeddingFetch([1, 2, 3]);

    const { provider } = await createLmstudioEmbeddingProvider({
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://localhost:1234",
              headers: {
                "X-Provider": "provider",
                "X-Config-Only": "from-provider",
              },
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      provider: "lmstudio",
      model: "",
      fallback: "none",
      remote: {
        baseUrl: "http://localhost:9999",
        apiKey: "remote-lmstudio-key",
        headers: {
          "X-Provider": "remote",
          "X-Remote-Only": "from-remote",
        },
      },
    });

    await provider.embedBatch(["one", "two"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:9999/v1/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer remote-lmstudio-key",
          "X-Provider": "remote",
          "X-Config-Only": "from-provider",
          "X-Remote-Only": "from-remote",
        }),
      }),
    );
    expect(resolveLmstudioRuntimeApiKeyMock).not.toHaveBeenCalled();
    expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:9999/v1",
      apiKey: "remote-lmstudio-key",
      headers: {
        "X-Provider": "remote",
        "X-Config-Only": "from-provider",
        "X-Remote-Only": "from-remote",
      },
      ssrfPolicy: { allowedHostnames: ["localhost"] },
      modelKey: "text-embedding-nomic-embed-text-v1.5",
      timeoutMs: 120_000,
    });
  });

  it("preserves remote Authorization header auth for primary lmstudio", async () => {
    ensureLmstudioModelLoadedMock.mockResolvedValue(undefined);
    resolveLmstudioRuntimeApiKeyMock.mockResolvedValue("stale-profile-key");

    const fetchMock = mockEmbeddingFetch([1, 2, 3]);

    const { provider } = await createLmstudioEmbeddingProvider({
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://localhost:1234",
              headers: {
                "X-Provider": "provider",
              },
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      provider: "lmstudio",
      model: "",
      fallback: "none",
      remote: {
        baseUrl: "http://localhost:9999",
        headers: {
          Authorization: "Bearer remote-proxy-token",
          "X-Remote-Only": "from-remote",
        },
      },
    });

    await provider.embedBatch(["one", "two"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:9999/v1/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer remote-proxy-token",
          "X-Provider": "provider",
          "X-Remote-Only": "from-remote",
        }),
      }),
    );
    expect(resolveLmstudioRuntimeApiKeyMock).not.toHaveBeenCalled();
    expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:9999/v1",
      apiKey: undefined,
      headers: {
        "X-Provider": "provider",
        Authorization: "Bearer remote-proxy-token",
        "X-Remote-Only": "from-remote",
      },
      ssrfPolicy: { allowedHostnames: ["localhost"] },
      modelKey: "text-embedding-nomic-embed-text-v1.5",
      timeoutMs: 120_000,
    });
  });

  it("ignores memorySearch remote overrides for fallback lmstudio activation", async () => {
    ensureLmstudioModelLoadedMock.mockResolvedValue(undefined);
    resolveLmstudioRuntimeApiKeyMock.mockResolvedValue("profile-key");

    const fetchMock = mockEmbeddingFetch([1, 2, 3]);

    const { provider } = await createLmstudioEmbeddingProvider({
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://localhost:1234",
              headers: {
                "X-Provider": "provider",
                "X-Config-Only": "from-provider",
              },
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      provider: "openai",
      model: "",
      fallback: "lmstudio",
      remote: {
        baseUrl: "http://localhost:9999",
        apiKey: "remote-lmstudio-key",
        headers: {
          "X-Provider": "remote",
          "X-Remote-Only": "from-remote",
        },
      },
    });

    await provider.embedBatch(["one", "two"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:1234/v1/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer profile-key",
          "X-Provider": "provider",
          "X-Config-Only": "from-provider",
        }),
      }),
    );
    const callHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(callHeaders["X-Remote-Only"]).toBeUndefined();
    expect(resolveLmstudioRuntimeApiKeyMock).toHaveBeenCalled();
    expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "profile-key",
      headers: {
        "X-Provider": "provider",
        "X-Config-Only": "from-provider",
      },
      ssrfPolicy: { allowedHostnames: ["localhost"] },
      modelKey: "text-embedding-nomic-embed-text-v1.5",
      timeoutMs: 120_000,
    });
  });

  it("skips remote SecretRef resolution for fallback lmstudio activation", async () => {
    ensureLmstudioModelLoadedMock.mockResolvedValue(undefined);
    resolveLmstudioRuntimeApiKeyMock.mockResolvedValue("profile-key");

    const fetchMock = mockEmbeddingFetch([1, 2, 3]);

    const { provider } = await createLmstudioEmbeddingProvider({
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://localhost:1234",
              headers: {
                "X-Provider": "provider",
              },
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      provider: "openai",
      model: "",
      fallback: "lmstudio",
      remote: {
        baseUrl: "http://localhost:9999",
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        headers: {
          "X-Remote-Only": "from-remote",
        },
      },
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:1234/v1/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer profile-key",
          "X-Provider": "provider",
        }),
      }),
    );
    const callHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(callHeaders["X-Remote-Only"]).toBeUndefined();
    expect(resolveLmstudioRuntimeApiKeyMock).toHaveBeenCalled();
  });

  it("uses env-template-backed provider api keys in embedding requests", async () => {
    ensureLmstudioModelLoadedMock.mockResolvedValue(undefined);
    resolveLmstudioRuntimeApiKeyMock.mockResolvedValue("template-lmstudio-key");

    const fetchMock = mockEmbeddingFetch([0.3, 0.4]);

    const { provider } = await createLmstudioEmbeddingProvider({
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://localhost:1234/v1",
              apiKey: "${LM_API_TOKEN}",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      provider: "lmstudio",
      model: "text-embedding-nomic-embed-text-v1.5",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:1234/v1/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer template-lmstudio-key",
        }),
      }),
    );
  });
});
