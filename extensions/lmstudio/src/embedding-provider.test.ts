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
const fetchLmstudioModelsMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => ({
    reachable: true,
    status: 200,
    models: [] as Array<{
      type?: "llm" | "embedding";
      key?: string;
      variants?: unknown;
      selected_variant?: unknown;
      loaded_instances?: unknown[];
    }>,
  })),
);
const resolveLmstudioProviderHeadersMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => undefined),
);
const resolveLmstudioRuntimeApiKeyMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => undefined),
);
const embeddedModels = vi.hoisted(() => [] as string[]);
const createRemoteEmbeddingProviderMock = vi.hoisted(() =>
  vi.fn((params: { client: { model: string } }) => {
    const providerModel = params.client.model;
    return {
      id: "lmstudio",
      model: providerModel,
      embed: vi.fn(async () => {
        embeddedModels.push(params.client.model);
        return [1, 0];
      }),
      embedBatch: vi.fn(async (texts: string[]) => {
        embeddedModels.push(params.client.model);
        return texts.map(() => [1, 0]);
      }),
    };
  }),
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
    fetchLmstudioModels: (params: unknown) => fetchLmstudioModelsMock(params),
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
    fetchLmstudioModelsMock.mockClear();
    fetchLmstudioModelsMock.mockResolvedValue({ reachable: true, status: 200, models: [] });
    createRemoteEmbeddingProviderMock.mockClear();
    embeddedModels.length = 0;
    resolveLmstudioProviderHeadersMock.mockClear();
    resolveLmstudioRuntimeApiKeyMock.mockClear();
  });

  it.each([
    {
      name: "model contextTokens before its native window",
      model: { contextTokens: 4096, contextWindow: 8192 },
      expected: 4096,
    },
    {
      name: "model contextWindow when no active-input cap is set",
      model: { contextWindow: 8192 },
      expected: 8192,
    },
    {
      name: "the loader default when no context is configured",
      expected: undefined,
    },
  ])("uses $name", async ({ model, expected }) => {
    await expect(readRequestedContextLength(buildConfig({ model }))).resolves.toBe(expected);
  });

  it.each(["lmstudio", "lmstudio-spark"])(
    "honors the preload opt-out for %s while retaining request-time service leases",
    async (providerId) => {
      const release = vi.fn();
      const acquireLocalService = vi.fn(async () => ({ release }));
      const { provider } = await createLmstudioEmbeddingProvider({
        config: {
          models: {
            providers: {
              [providerId]: {
                baseUrl: "http://spark.local:1234/v1",
                params: { preload: false },
                localService: { command: "/usr/bin/lms-spark" },
                models: [{ id: EMBEDDING_MODEL }],
              },
            },
          },
        } as unknown as OpenClawConfig,
        provider: providerId,
        model: `${providerId}/${EMBEDDING_MODEL}`,
        fallback: "none",
        acquireLocalService,
      });

      expect(ensureLmstudioModelLoadedMock).not.toHaveBeenCalled();
      expect(fetchLmstudioModelsMock).not.toHaveBeenCalled();
      expect(acquireLocalService).not.toHaveBeenCalled();

      await expect(provider.embed("hello", { inputType: "query" })).resolves.toEqual([1, 0]);

      expect(acquireLocalService).toHaveBeenCalledOnce();
      expect(acquireLocalService).toHaveBeenCalledWith(
        expect.objectContaining({ providerId, baseUrl: "http://spark.local:1234/v1" }),
        undefined,
      );
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("keeps each query-batch service lease until its request settles", async () => {
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    const acquireLocalService = vi
      .fn()
      .mockResolvedValueOnce({ release: firstRelease })
      .mockResolvedValueOnce({ release: secondRelease });
    let resolveSecond: (value: number[]) => void = () => {};
    const secondResult = new Promise<number[]>((resolve) => {
      resolveSecond = resolve;
    });
    const remoteEmbed = vi
      .fn()
      .mockRejectedValueOnce(new Error("first query failed"))
      .mockImplementationOnce(async () => await secondResult);
    const remoteEmbedBatch = vi.fn(
      async (inputs: unknown[]) =>
        await Promise.all(
          inputs.map(async (input) => await remoteEmbed(input, { inputType: "query" })),
        ),
    );
    createRemoteEmbeddingProviderMock.mockReturnValueOnce({
      id: "lmstudio",
      model: EMBEDDING_MODEL,
      embed: remoteEmbed,
      embedBatch: remoteEmbedBatch,
    });
    const { provider } = await createLmstudioEmbeddingProvider({
      config: buildConfig({
        provider: {
          params: { preload: false },
          localService: { command: "/usr/bin/lms" },
        },
      }),
      provider: "lmstudio",
      model: EMBEDDING_MODEL,
      fallback: "none",
      acquireLocalService,
    });

    const pending = provider.embedBatch(["first", "second"], { inputType: "query" });
    await expect(pending).rejects.toThrow("first query failed");

    expect(acquireLocalService).toHaveBeenCalledTimes(2);
    expect(acquireLocalService).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ providerId: "lmstudio", baseUrl: "http://localhost:1234/v1" }),
      undefined,
    );
    expect(acquireLocalService).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ providerId: "lmstudio", baseUrl: "http://localhost:1234/v1" }),
      undefined,
    );
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).not.toHaveBeenCalled();
    expect(remoteEmbedBatch).not.toHaveBeenCalled();

    resolveSecond([2]);
    await vi.waitFor(() => expect(secondRelease).toHaveBeenCalledOnce());
  });

  it("resolves a JIT variant before freezing provider and cache identity", async () => {
    const requestedVariant = `${EMBEDDING_MODEL}@q4_k_m`;
    const release = vi.fn();
    const acquireLocalService = vi.fn(async () => ({ release }));
    fetchLmstudioModelsMock.mockResolvedValueOnce({
      reachable: true,
      status: 200,
      models: [
        {
          type: "embedding",
          key: EMBEDDING_MODEL,
          variants: [requestedVariant],
          selected_variant: requestedVariant,
          loaded_instances: [],
        },
      ],
    });

    const options = {
      config: buildConfig({
        model: { id: requestedVariant },
        provider: {
          params: { preload: false },
          localService: { command: "/usr/bin/lms" },
        },
      }),
      provider: "lmstudio",
      model: `lmstudio/${requestedVariant}`,
      fallback: "none",
      acquireLocalService,
    };
    const result = await lmstudioMemoryEmbeddingProviderAdapter.create(options);
    if (!result.provider) {
      throw new Error("expected LM Studio embedding provider");
    }

    expect(ensureLmstudioModelLoadedMock).not.toHaveBeenCalled();
    expect(fetchLmstudioModelsMock).toHaveBeenCalledOnce();
    expect(acquireLocalService).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(result.provider.model).toBe(EMBEDDING_MODEL);
    expect(result.runtime?.cacheKeyData).toMatchObject({ model: EMBEDDING_MODEL });

    await expect(result.provider.embed("hello", { inputType: "query" })).resolves.toEqual([1, 0]);

    expect(embeddedModels).toEqual([EMBEDDING_MODEL]);
    expect(acquireLocalService).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("uses the canonical preloaded model for embedding requests and memory identity", async () => {
    const requestedVariant = `${EMBEDDING_MODEL}@q4_k_m`;
    const result = await lmstudioMemoryEmbeddingProviderAdapter.create({
      config: buildConfig({ model: { id: requestedVariant } }),
      provider: "lmstudio",
      model: `lmstudio/${requestedVariant}`,
      fallback: "none",
    });

    expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledWith(
      expect.objectContaining({ modelKey: requestedVariant }),
    );
    expect(createRemoteEmbeddingProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ client: expect.objectContaining({ model: EMBEDDING_MODEL }) }),
    );
    expect(result.provider?.model).toBe(EMBEDDING_MODEL);
    expect(result.runtime?.cacheKeyData).toMatchObject({ model: EMBEDDING_MODEL });
  });

  it("retains the discovered canonical model when its preload subsequently fails", async () => {
    const requestedVariant = `${EMBEDDING_MODEL}@q4_k_m`;
    ensureLmstudioModelLoadedMock.mockRejectedValueOnce(
      Object.assign(new Error("fixture preload rejected"), { resolvedModelKey: EMBEDDING_MODEL }),
    );

    const result = await lmstudioMemoryEmbeddingProviderAdapter.create({
      config: buildConfig({ model: { id: requestedVariant } }),
      provider: "lmstudio",
      model: `lmstudio/${requestedVariant}`,
      fallback: "none",
    });

    expect(createRemoteEmbeddingProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ client: expect.objectContaining({ model: EMBEDDING_MODEL }) }),
    );
    expect(result.provider?.model).toBe(EMBEDDING_MODEL);
    expect(result.runtime?.cacheKeyData).toMatchObject({ model: EMBEDDING_MODEL });
  });

  it("keeps the requested model when preload fails before discovering its identity", async () => {
    const requestedVariant = `${EMBEDDING_MODEL}@q4_k_m`;
    ensureLmstudioModelLoadedMock.mockRejectedValueOnce(new Error("fixture discovery unavailable"));

    const { client } = await createLmstudioEmbeddingProvider({
      config: buildConfig({ model: { id: requestedVariant } }),
      provider: "lmstudio",
      model: `lmstudio/${requestedVariant}`,
      fallback: "none",
    });

    expect(client.model).toBe(requestedVariant);
    expect(createRemoteEmbeddingProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ client: expect.objectContaining({ model: requestedVariant }) }),
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
    await expect(provider.embed("hello", { inputType: "query" })).resolves.toEqual([1, 0]);

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
              apiKey: "provider-host-key",
              headers: { "X-Provider-Tenant": "provider-a" },
              localService: { command: process.execPath },
              models: [{ id: EMBEDDING_MODEL }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "lmstudio-spark",
      model: `lmstudio-spark/${EMBEDDING_MODEL}`,
      fallback: "none",
      remote: {
        baseUrl: "http://memory.local:1234/v1",
        headers: { "X-Remote-Tenant": "remote-b" },
      },
      acquireLocalService,
    };
    const { provider, client } = await createLmstudioEmbeddingProvider(options);

    await expect(provider.embed("hello", { inputType: "query" })).resolves.toEqual([1, 0]);
    expect(acquireLocalService).not.toHaveBeenCalled();
    expect(client.headers).toEqual({
      "Content-Type": "application/json",
      "X-Remote-Tenant": "remote-b",
    });
  });

  it("does not inherit primary remote headers when LM Studio activates as a fallback", async () => {
    const { client } = await createLmstudioEmbeddingProvider({
      config: buildConfig({
        provider: {
          params: { preload: false },
          headers: { "X-Provider-Tenant": "provider-a" },
        },
      }),
      provider: "google",
      model: EMBEDDING_MODEL,
      fallback: "lmstudio",
      remote: {
        baseUrl: "http://memory.local:1234/v1",
        apiKey: "primary-provider-key",
        headers: { "X-Remote-Tenant": "remote-b" },
      },
    });

    expect(client.baseUrl).toBe("http://localhost:1234/v1");
    expect(client.headers).toEqual({ "Content-Type": "application/json" });
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

  it("keeps API key rotation out of memory identity without dropping tenant headers", async () => {
    const readIdentity = async (headers: Record<string, string>) =>
      (
        await lmstudioMemoryEmbeddingProviderAdapter.create({
          config: buildConfig({ provider: { params: { preload: false } } }),
          provider: "lmstudio",
          model: EMBEDDING_MODEL,
          fallback: "none",
          remote: { headers },
        })
      ).runtime?.cacheKeyData;

    const defaultIdentity = await readIdentity({});
    const firstTenant = await readIdentity({
      Authorization: "Bearer synthetic-before",
      "X-API-KEY": "synthetic-key-before",
      "X-Tenant": "tenant-a",
    });
    const rotatedTenant = await readIdentity({
      Authorization: "Bearer synthetic-after",
      "x-Api-Key": "synthetic-key-after",
      "X-Tenant": "tenant-a",
    });
    const otherTenant = await readIdentity({
      "X-Api-Key": "synthetic-key-after",
      "X-Tenant": "tenant-b",
    });

    expect(defaultIdentity).toEqual({
      provider: "lmstudio",
      baseUrl: "http://localhost:1234/v1",
      model: EMBEDDING_MODEL,
      headers: [["Content-Type", "application/json"]],
    });
    expect(firstTenant).toEqual(rotatedTenant);
    expect(firstTenant).not.toEqual(otherTenant);
    expect(firstTenant).toMatchObject({
      headers: [
        ["Content-Type", "application/json"],
        ["X-Tenant", "tenant-a"],
      ],
    });
  });
});
