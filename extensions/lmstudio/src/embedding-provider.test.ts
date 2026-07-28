// LM Studio embedding provider tests cover preload context-length precedence.
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lmstudioMemoryEmbeddingProviderAdapter } from "../memory-embedding-adapter.js";
import { createLmstudioEmbeddingProvider } from "./embedding-provider.js";

const ensureLmstudioModelLoadedMock = vi.hoisted(() =>
  vi.fn(
    async (_params?: { requestedContextLength?: number }) => "text-embedding-nomic-embed-text-v1.5",
  ),
);
const resolveLmstudioProviderHeadersMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => undefined),
);
const resolveLmstudioRuntimeApiKeyMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => undefined),
);
const createRemoteEmbeddingProviderMock = vi.hoisted(() =>
  vi.fn(() => ({
    id: "lmstudio",
    model: "text-embedding-nomic-embed-text-v1.5",
    embedQuery: vi.fn(async () => [1, 0]),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
  })),
);

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-embeddings")>();
  return {
    ...actual,
    createRemoteEmbeddingProvider: createRemoteEmbeddingProviderMock,
  };
});

vi.mock("./models.fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./models.fetch.js")>();
  return {
    ...actual,
    ensureLmstudioModelLoaded: (params: { requestedContextLength?: number }) =>
      ensureLmstudioModelLoadedMock(params),
  };
});

vi.mock("./runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime.js")>();
  return {
    ...actual,
    resolveLmstudioProviderHeaders: (params: unknown) => resolveLmstudioProviderHeadersMock(params),
    resolveLmstudioRuntimeApiKey: (params: unknown) => resolveLmstudioRuntimeApiKeyMock(params),
  };
});

const EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";

function buildConfig(params: {
  model?: Record<string, unknown>;
  provider?: Record<string, unknown>;
}): OpenClawConfig {
  return {
    models: {
      providers: {
        lmstudio: {
          baseUrl: "http://localhost:1234/v1",
          models: [{ id: EMBEDDING_MODEL, ...params.model }],
          ...params.provider,
        },
      },
    },
  } as unknown as OpenClawConfig;
}

async function readRequestedContextLength(config: OpenClawConfig): Promise<unknown> {
  await createLmstudioEmbeddingProvider({
    config,
    provider: "lmstudio",
    model: EMBEDDING_MODEL,
    fallback: "none",
  });
  expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledTimes(1);
  return ensureLmstudioModelLoadedMock.mock.calls[0]?.[0]?.requestedContextLength;
}

describe("createLmstudioEmbeddingProvider preload context length", () => {
  beforeEach(() => {
    ensureLmstudioModelLoadedMock.mockClear();
    createRemoteEmbeddingProviderMock.mockClear();
    resolveLmstudioProviderHeadersMock.mockClear();
    resolveLmstudioRuntimeApiKeyMock.mockClear();
  });

  it.each([
    {
      name: "model contextTokens before every fallback",
      model: { contextTokens: 4096, contextWindow: 8192 },
      provider: { contextTokens: 2048, contextWindow: 16384 },
      expected: 4096,
    },
    {
      name: "provider contextTokens as the model's effective cap",
      model: { contextWindow: 8192 },
      provider: { contextTokens: 4096, contextWindow: 16384 },
      expected: 4096,
    },
    {
      name: "model contextWindow when below the provider cap",
      model: { contextWindow: 8192 },
      provider: { contextTokens: 16384, contextWindow: 32768 },
      expected: 8192,
    },
    {
      name: "provider contextTokens when the model has no context fields",
      provider: { contextTokens: 4096, contextWindow: 16384 },
      expected: 4096,
    },
    {
      name: "model contextWindow before provider contextWindow",
      model: { contextWindow: 8192 },
      provider: { contextWindow: 16384 },
      expected: 8192,
    },
    {
      name: "provider contextWindow as the final configured fallback",
      provider: { contextWindow: 16384 },
      expected: 16384,
    },
    {
      name: "the loader default when no context is configured",
      expected: undefined,
    },
  ])("uses $name", async ({ model, provider, expected }) => {
    await expect(readRequestedContextLength(buildConfig({ model, provider }))).resolves.toBe(
      expected,
    );
  });

  it("leases the exact configured alias for preload and embedding requests", async () => {
    const release = vi.fn();
    const acquireLocalService = vi.fn(async (_target: unknown) => ({ release }));
    const service = {
      command: "/usr/bin/lms-spark",
      args: ["server", "start"],
      idleStopMs: 10,
    };
    const options = {
      config: {
        models: {
          providers: {
            "lmstudio-spark": {
              baseUrl: "http://spark.local:1234/v1",
              apiKey: "spark-key",
              localService: service,
              models: [{ id: EMBEDDING_MODEL }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "lmstudio-spark",
      model: `lmstudio-spark/${EMBEDDING_MODEL}`,
      fallback: "none",
      acquireLocalService,
    };

    const { provider } = await createLmstudioEmbeddingProvider(options);
    await expect(provider.embedQuery("hello")).resolves.toEqual([1, 0]);

    expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "spark-key" }),
    );
    expect(resolveLmstudioRuntimeApiKeyMock).not.toHaveBeenCalled();
    expect(acquireLocalService).toHaveBeenCalledTimes(2);
    expect(acquireLocalService).toHaveBeenNthCalledWith(
      1,
      {
        providerId: "lmstudio-spark",
        baseUrl: "http://spark.local:1234/v1",
        headers: {
          Authorization: "Bearer spark-key",
          "Content-Type": "application/json",
        },
      },
      undefined,
    );
    expect(acquireLocalService).toHaveBeenNthCalledWith(
      2,
      {
        providerId: "lmstudio-spark",
        baseUrl: "http://spark.local:1234/v1",
        headers: {
          Authorization: "Bearer spark-key",
          "Content-Type": "application/json",
        },
      },
      undefined,
    );
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("does not lease a configured local service for a remote endpoint override", async () => {
    const acquireLocalService = vi.fn(async () => ({ release: vi.fn() }));
    const options = {
      config: {
        models: {
          providers: {
            "lmstudio-spark": {
              baseUrl: "http://spark.local:1234/v1",
              localService: { command: process.execPath },
              models: [{ id: EMBEDDING_MODEL }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "lmstudio-spark",
      model: `lmstudio-spark/${EMBEDDING_MODEL}`,
      fallback: "none",
      remote: { baseUrl: "http://memory.local:1234/v1" },
      acquireLocalService,
    };
    const { provider } = await createLmstudioEmbeddingProvider(options);

    await expect(provider.embedQuery("hello")).resolves.toEqual([1, 0]);
    expect(acquireLocalService).not.toHaveBeenCalled();
  });

  it("preserves a scheme-added /api/v1 local service target", async () => {
    const acquireLocalService = vi.fn(async () => ({ release: vi.fn() }));
    const options = {
      config: {
        models: {
          providers: {
            "lmstudio-spark": {
              baseUrl: "spark.local:1234/api/v1",
              localService: { command: process.execPath },
              models: [{ id: EMBEDDING_MODEL }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "lmstudio-spark",
      model: `lmstudio-spark/${EMBEDDING_MODEL}`,
      fallback: "none",
      acquireLocalService,
    };

    await createLmstudioEmbeddingProvider(options);

    expect(resolveLmstudioRuntimeApiKeyMock).not.toHaveBeenCalled();
    expect(acquireLocalService).toHaveBeenCalledWith(
      {
        providerId: "lmstudio-spark",
        baseUrl: "http://spark.local:1234/api/v1",
        headers: { "Content-Type": "application/json" },
      },
      undefined,
    );
  });

  it("preserves configured provider aliases in the memory adapter", async () => {
    const result = await lmstudioMemoryEmbeddingProviderAdapter.create({
      config: {
        models: {
          providers: {
            "lmstudio-spark": {
              baseUrl: "http://spark.local:1234/v1",
              models: [{ id: EMBEDDING_MODEL }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "lmstudio-spark",
      model: `lmstudio-spark/${EMBEDDING_MODEL}`,
      fallback: "none",
    });

    expect(result.runtime?.cacheKeyData).toMatchObject({
      provider: "lmstudio-spark",
      baseUrl: "http://spark.local:1234/v1",
      model: EMBEDDING_MODEL,
    });
  });
});
