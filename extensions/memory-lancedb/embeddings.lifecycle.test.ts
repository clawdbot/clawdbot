import { expectDefined } from "@openclaw/normalization-core";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "openclaw/plugin-sdk/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import type { MemoryConfig } from "./config.js";

const providerMocks = vi.hoisted(() => ({
  getMemoryEmbeddingProvider: vi.fn(),
  authMutationListeners: new Set<
    (event: { agentDir?: string; affectsInheritedStores: boolean }) => void
  >(),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-embeddings")>();
  return {
    ...actual,
    getMemoryEmbeddingProvider: providerMocks.getMemoryEmbeddingProvider,
    registerRuntimeAuthProfileStoreMutationListener: (
      listener: Parameters<typeof actual.registerRuntimeAuthProfileStoreMutationListener>[0],
    ) => {
      providerMocks.authMutationListeners.add(listener);
      const unregister = actual.registerRuntimeAuthProfileStoreMutationListener(listener);
      return () => {
        providerMocks.authMutationListeners.delete(listener);
        unregister();
      };
    },
  };
});

import { createEmbeddings, type Embeddings } from "./embeddings.js";

function createApi(): OpenClawPluginApi {
  const config = {};
  return {
    config,
    runtime: {
      config: { current: () => config },
      agent: { resolveAgentDir: () => "/tmp/openclaw-agent" },
    },
  } as unknown as OpenClawPluginApi;
}

const embeddingConfig = {
  provider: "openai",
  model: "text-embedding-3-small",
} as MemoryConfig["embedding"];

function embed(
  embeddings: Embeddings,
  agentId: string,
  text: string,
  embedding: MemoryConfig["embedding"] = embeddingConfig,
) {
  return embeddings.embed(agentId, text, embedding);
}

describe("memory-lancedb provider lifecycle", () => {
  it("authenticates private agent embeddings without using the default agent's credentials", async () => {
    const config = {};
    const resolveAgentDir = vi.fn((_config: unknown, agentId: string) => `/tmp/agent-${agentId}`);
    const embedQuery = vi.fn(async () => [0.1, 0.2, 0.3]);
    const createProvider = vi.fn(async (options: { agentDir?: string }) => {
      if (options.agentDir !== "/tmp/agent-private") {
        throw new Error("No provider credential for the default agent");
      }
      return {
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embedQuery,
          embedBatch: vi.fn(async () => [[0.1, 0.2, 0.3]]),
        },
      };
    });
    providerMocks.getMemoryEmbeddingProvider.mockReturnValue({
      id: "openai",
      create: createProvider,
    });
    const api = {
      config,
      runtime: {
        config: { current: () => config },
        agent: { resolveAgentDir },
      },
    } as unknown as OpenClawPluginApi;
    const embeddings = createEmbeddings(api);

    await expect(embed(embeddings, "private", "private account memory")).resolves.toEqual([
      0.1, 0.2, 0.3,
    ]);

    expect(resolveAgentDir).toHaveBeenCalledWith(config, "private");
    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: "/tmp/agent-private" }),
    );
    expect(embedQuery).toHaveBeenCalledWith("private account memory");
    await embeddings.close?.();
  });

  it("isolates concurrent agent providers and retires every account exactly once", async () => {
    const config = {};
    const requests: Array<{ agentDir: string; text: string }> = [];
    const closedAgentDirs: string[] = [];
    const createProvider = vi.fn(async (options: { agentDir?: string }) => {
      const agentDir = options.agentDir ?? "unscoped";
      return {
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embedQuery: vi.fn(async (text: string) => {
            requests.push({ agentDir, text });
            return [0.1, 0.2, 0.3];
          }),
          embedBatch: vi.fn(async () => [[0.1, 0.2, 0.3]]),
          close: vi.fn(async () => {
            closedAgentDirs.push(agentDir);
          }),
        },
      };
    });
    providerMocks.getMemoryEmbeddingProvider.mockReturnValue({
      id: "openai",
      create: createProvider,
    });
    const api = {
      config,
      runtime: {
        config: { current: () => config },
        agent: { resolveAgentDir: (_config: unknown, agentId: string) => `/tmp/agent-${agentId}` },
      },
    } as unknown as OpenClawPluginApi;
    const embeddings = createEmbeddings(api);

    await Promise.all([
      embed(embeddings, "private", "private first"),
      embed(embeddings, "main", "main first"),
      embed(embeddings, " PRIVATE ", "private second"),
      embed(embeddings, "main", "main second"),
    ]);

    expect(createProvider).toHaveBeenCalledTimes(2);
    expect(requests).toEqual(
      expect.arrayContaining([
        { agentDir: "/tmp/agent-private", text: "private first" },
        { agentDir: "/tmp/agent-private", text: "private second" },
        { agentDir: "/tmp/agent-main", text: "main first" },
        { agentDir: "/tmp/agent-main", text: "main second" },
      ]),
    );

    await embeddings.close?.();
    expect(closedAgentDirs.toSorted()).toEqual(["/tmp/agent-main", "/tmp/agent-private"]);
  });

  it("invalidates only the matching normalized auth owner and unregisters on close", async () => {
    const config = {};
    const closedAgentDirs: string[] = [];
    const createProvider = vi.fn(async (options: { agentDir?: string }) => {
      const agentDir = options.agentDir ?? "unscoped";
      return {
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embedQuery: vi.fn(async () => [0.1, 0.2, 0.3]),
          embedBatch: vi.fn(async () => [[0.1, 0.2, 0.3]]),
          close: vi.fn(async () => {
            closedAgentDirs.push(agentDir);
          }),
        },
      };
    });
    providerMocks.getMemoryEmbeddingProvider.mockReturnValue({
      id: "openai",
      create: createProvider,
    });
    const api = {
      config,
      runtime: {
        config: { current: () => config },
        agent: { resolveAgentDir: (_config: unknown, agentId: string) => `/tmp/agent-${agentId}` },
      },
    } as unknown as OpenClawPluginApi;
    const embeddings = createEmbeddings(api);

    await Promise.all([
      embed(embeddings, "private", "private before rotation"),
      embed(embeddings, "other", "other before rotation"),
    ]);
    const listener = Array.from(providerMocks.authMutationListeners).at(-1);
    expect(listener).toBeTypeOf("function");
    listener?.({
      agentDir: "/tmp/agent-private/../agent-private",
      affectsInheritedStores: false,
    });

    await embed(embeddings, "other", "other warm provider");
    expect(createProvider).toHaveBeenCalledTimes(2);
    await embed(embeddings, "private", "private rotated provider");
    expect(createProvider).toHaveBeenCalledTimes(3);
    expect(closedAgentDirs).toEqual(["/tmp/agent-private"]);

    await embeddings.close?.();
    expect(providerMocks.authMutationListeners.has(expectDefined(listener, "auth listener"))).toBe(
      false,
    );
    expect(closedAgentDirs.toSorted()).toEqual([
      "/tmp/agent-other",
      "/tmp/agent-private",
      "/tmp/agent-private",
    ]);
  });

  it("rotates actual private auth snapshots without replacing the runtime config", async () => {
    const config = {};
    const agentDir = "/tmp/openclaw-lancedb-private-auth-rotation";
    const profileId = "openai:private";
    const requests: Array<{ text: string; credential: string }> = [];
    const publishCredential = (credential: string | undefined) => {
      replaceRuntimeAuthProfileStoreSnapshots([
        { store: { version: 1, profiles: {} } },
        {
          agentDir,
          store: {
            version: 1,
            profiles: credential
              ? {
                  [profileId]: { type: "api_key", provider: "openai", key: credential },
                }
              : {},
          },
        },
      ]);
    };
    const closeProvider = vi.fn(async () => {});
    const createProvider = vi.fn(async (options: { agentDir?: string }) => {
      const profile = ensureAuthProfileStore(options.agentDir, {
        externalCli: { mode: "none" },
        readOnly: true,
        syncExternalCli: false,
      }).profiles[profileId];
      if (profile?.type !== "api_key" || !profile.key) {
        throw new Error("Private agent credentials were revoked");
      }
      const credential = profile.key;
      return {
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embedQuery: vi.fn(async (text: string) => {
            requests.push({ text, credential });
            return [0.1, 0.2, 0.3];
          }),
          embedBatch: vi.fn(async () => [[0.1, 0.2, 0.3]]),
          close: closeProvider,
        },
      };
    });
    providerMocks.getMemoryEmbeddingProvider.mockReturnValue({
      id: "openai",
      create: createProvider,
    });
    const api = {
      config,
      runtime: {
        config: { current: () => config },
        agent: { resolveAgentDir: () => agentDir },
      },
    } as unknown as OpenClawPluginApi;
    const embeddings = createEmbeddings(api);

    try {
      publishCredential("fixture-old-account");
      await embed(embeddings, "private", "before-account-rotation");
      publishCredential("fixture-new-account");
      await embed(embeddings, "private", "private-secret-after-account-rotation");

      expect(requests).toEqual([
        { text: "before-account-rotation", credential: "fixture-old-account" },
        { text: "private-secret-after-account-rotation", credential: "fixture-new-account" },
      ]);
      expect(createProvider).toHaveBeenCalledTimes(2);
      expect(closeProvider).toHaveBeenCalledOnce();

      publishCredential(undefined);
      await expect(embed(embeddings, "private", "private-secret-after-revocation")).rejects.toThrow(
        "Private agent credentials were revoked",
      );
      expect(requests).toHaveLength(2);
      expect(closeProvider).toHaveBeenCalledTimes(2);
    } finally {
      await embeddings.close?.();
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("invalidates every inheriting agent when the actual main auth snapshot rotates", async () => {
    const config = {};
    const agentDirs = {
      private: "/tmp/openclaw-lancedb-inherited-private",
      secondary: "/tmp/openclaw-lancedb-inherited-secondary",
    };
    const profileId = "openai:inherited";
    const requests: Array<{ agentDir: string; credential: string; text: string }> = [];
    const publishMainCredential = (credential: string) => {
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          store: {
            version: 1,
            profiles: {
              [profileId]: { type: "api_key", provider: "openai", key: credential },
            },
          },
        },
        ...Object.values(agentDirs).map((agentDir) => ({
          agentDir,
          store: { version: 1, profiles: {} },
        })),
      ]);
    };
    const closeProvider = vi.fn(async (_agentDir: string, _credential: string) => {});
    const createProvider = vi.fn(async (options: { agentDir?: string }) => {
      const agentDir = expectDefined(options.agentDir, "inherited agent owner");
      const profile = ensureAuthProfileStore(agentDir, {
        externalCli: { mode: "none" },
        readOnly: true,
        syncExternalCli: false,
      }).profiles[profileId];
      if (profile?.type !== "api_key" || !profile.key) {
        throw new Error("Inherited main credential is unavailable");
      }
      const credential = profile.key;
      return {
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embedQuery: vi.fn(async (text: string) => {
            requests.push({ agentDir, credential, text });
            return [0.1, 0.2, 0.3];
          }),
          embedBatch: vi.fn(async () => [[0.1, 0.2, 0.3]]),
          close: async () => closeProvider(agentDir, credential),
        },
      };
    });
    providerMocks.getMemoryEmbeddingProvider.mockReturnValue({
      id: "openai",
      create: createProvider,
    });
    const api = {
      config,
      runtime: {
        config: { current: () => config },
        agent: {
          resolveAgentDir: (_config: unknown, agentId: string) =>
            agentDirs[agentId as keyof typeof agentDirs],
        },
      },
    } as unknown as OpenClawPluginApi;
    const embeddings = createEmbeddings(api);

    try {
      publishMainCredential("fixture-inherited-old");
      await Promise.all([
        embed(embeddings, "private", "private old inherited credential"),
        embed(embeddings, "secondary", "secondary old inherited credential"),
      ]);
      publishMainCredential("fixture-inherited-new");
      await Promise.all([
        embed(embeddings, "private", "private new inherited credential"),
        embed(embeddings, "secondary", "secondary new inherited credential"),
      ]);

      expect(createProvider).toHaveBeenCalledTimes(4);
      expect(closeProvider.mock.calls).toEqual(
        expect.arrayContaining([
          [agentDirs.private, "fixture-inherited-old"],
          [agentDirs.secondary, "fixture-inherited-old"],
        ]),
      );
      expect(requests).toEqual(
        expect.arrayContaining([
          {
            agentDir: agentDirs.private,
            credential: "fixture-inherited-old",
            text: "private old inherited credential",
          },
          {
            agentDir: agentDirs.secondary,
            credential: "fixture-inherited-old",
            text: "secondary old inherited credential",
          },
          {
            agentDir: agentDirs.private,
            credential: "fixture-inherited-new",
            text: "private new inherited credential",
          },
          {
            agentDir: agentDirs.secondary,
            credential: "fixture-inherited-new",
            text: "secondary new inherited credential",
          },
        ]),
      );
    } finally {
      await embeddings.close?.();
      clearRuntimeAuthProfileStoreSnapshots();
    }

    expect(closeProvider.mock.calls).toHaveLength(4);
    expect(closeProvider.mock.calls).toEqual(
      expect.arrayContaining([
        [agentDirs.private, "fixture-inherited-old"],
        [agentDirs.secondary, "fixture-inherited-old"],
        [agentDirs.private, "fixture-inherited-new"],
        [agentDirs.secondary, "fixture-inherited-new"],
      ]),
    );
  });

  it("retires cached agent providers and fails closed after runtime config replacement", async () => {
    const initialConfig = { authGeneration: "valid" };
    const revokedConfig = { authGeneration: "revoked" };
    let currentConfig = initialConfig;
    const oldEmbedQuery = vi.fn(async () => [0.1, 0.2, 0.3]);
    const closeOldProvider = vi.fn(async () => {});
    const createProvider = vi.fn(async (options: { config: unknown; agentDir?: string }) => {
      if (options.config === revokedConfig) {
        throw new Error("Private agent credentials were revoked");
      }
      return {
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embedQuery: oldEmbedQuery,
          embedBatch: vi.fn(async () => [[0.1, 0.2, 0.3]]),
          close: closeOldProvider,
        },
      };
    });
    providerMocks.getMemoryEmbeddingProvider.mockReturnValue({
      id: "openai",
      create: createProvider,
    });
    const api = {
      config: initialConfig,
      runtime: {
        config: { current: () => currentConfig },
        agent: { resolveAgentDir: (_config: unknown, agentId: string) => `/tmp/agent-${agentId}` },
      },
    } as unknown as OpenClawPluginApi;
    const embeddings = createEmbeddings(api);

    await embed(embeddings, "private", "before revocation");
    currentConfig = revokedConfig;

    await expect(embed(embeddings, "private", "after revocation")).rejects.toThrow(
      "Private agent credentials were revoked",
    );
    expect(oldEmbedQuery).toHaveBeenCalledOnce();
    expect(oldEmbedQuery).toHaveBeenCalledWith("before revocation");
    expect(closeOldProvider).toHaveBeenCalledOnce();
    expect(createProvider).toHaveBeenCalledTimes(2);

    await embeddings.close?.();
  });

  it("rotates live embedding overrides after admitted work drains", async () => {
    let releaseOldEmbedding: () => void = () => {};
    const oldEmbeddingGate = new Promise<void>((resolve) => {
      releaseOldEmbedding = resolve;
    });
    let oldEmbeddingStarted: () => void = () => {};
    const oldEmbeddingStart = new Promise<void>((resolve) => {
      oldEmbeddingStarted = resolve;
    });
    const closeOldProvider = vi.fn(async () => {});
    const closeReplacementProvider = vi.fn(async () => {});
    const createProvider = vi.fn(
      async (options: { provider: string; model: string; remote?: { apiKey?: string } }) => {
        const isOld = options.remote?.apiKey === "fixture-old-key";
        return {
          provider: {
            id: options.provider,
            model: options.model,
            embedQuery: vi.fn(async () => {
              if (isOld) {
                oldEmbeddingStarted();
                await oldEmbeddingGate;
              }
              return isOld ? [0.1] : [0.2];
            }),
            embedBatch: vi.fn(async () => [[0.1]]),
            close: isOld ? closeOldProvider : closeReplacementProvider,
          },
        };
      },
    );
    providerMocks.getMemoryEmbeddingProvider.mockReturnValue({
      id: "fixture-provider",
      create: createProvider,
    });
    const embeddingIdentity = {
      provider: "fixture-provider",
      model: "fixture-model",
      dimensions: 3,
    } as const;
    const oldConfig = {
      ...embeddingIdentity,
      apiKey: "fixture-old-key",
      baseUrl: "https://old.example.test/v1",
    } satisfies MemoryConfig["embedding"];
    const newConfig = {
      ...embeddingIdentity,
      apiKey: "fixture-new-key",
      baseUrl: "https://new.example.test/v1",
    } satisfies MemoryConfig["embedding"];
    const embeddings = createEmbeddings(createApi());

    try {
      const oldEmbedding = embed(embeddings, "main", "old config request", oldConfig);
      await oldEmbeddingStart;
      const replacementEmbedding = embed(embeddings, "main", "new config request", newConfig);
      await Promise.resolve();
      expect(createProvider).toHaveBeenCalledOnce();
      expect(closeOldProvider).not.toHaveBeenCalled();

      releaseOldEmbedding();
      await expect(Promise.all([oldEmbedding, replacementEmbedding])).resolves.toEqual([
        [0.1],
        [0.2],
      ]);
      expect(createProvider.mock.calls.map(([options]) => options)).toEqual([
        expect.objectContaining({
          provider: oldConfig.provider,
          model: oldConfig.model,
          remote: { apiKey: oldConfig.apiKey, baseUrl: oldConfig.baseUrl },
          outputDimensionality: oldConfig.dimensions,
        }),
        expect.objectContaining({
          provider: newConfig.provider,
          model: newConfig.model,
          remote: { apiKey: newConfig.apiKey, baseUrl: newConfig.baseUrl },
          outputDimensionality: newConfig.dimensions,
        }),
      ]);
      expect(closeOldProvider).toHaveBeenCalledOnce();
      expect(
        expectDefined(closeOldProvider.mock.invocationCallOrder[0], "old config close order"),
      ).toBeLessThan(
        expectDefined(createProvider.mock.invocationCallOrder[1], "new config create order"),
      );
    } finally {
      releaseOldEmbedding();
      await embeddings.close?.();
    }

    expect(closeReplacementProvider).toHaveBeenCalledOnce();
  });

  it("drains an admitted embedding before retiring a rotated actual auth snapshot", async () => {
    const config = {};
    const agentDir = "/tmp/openclaw-lancedb-inflight-auth-rotation";
    const profileId = "openai:inflight";
    const publishCredential = (credential: string) => {
      replaceRuntimeAuthProfileStoreSnapshots([
        { store: { version: 1, profiles: {} } },
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              [profileId]: { type: "api_key", provider: "openai", key: credential },
            },
          },
        },
      ]);
    };
    let releaseOldEmbedding: () => void = () => {};
    const oldEmbeddingGate = new Promise<void>((resolve) => {
      releaseOldEmbedding = resolve;
    });
    let oldEmbeddingStarted: () => void = () => {};
    const oldEmbeddingStart = new Promise<void>((resolve) => {
      oldEmbeddingStarted = resolve;
    });
    const closeOldProvider = vi.fn(async () => {});
    const closeReplacementProvider = vi.fn(async () => {});
    const createProvider = vi.fn(async (options: { agentDir?: string }) => {
      const profile = ensureAuthProfileStore(options.agentDir, {
        externalCli: { mode: "none" },
        readOnly: true,
        syncExternalCli: false,
      }).profiles[profileId];
      if (profile?.type !== "api_key" || !profile.key) {
        throw new Error("in-flight agent credential unavailable");
      }
      const oldAccount = profile.key === "fixture-inflight-old";
      return {
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embedQuery: vi.fn(async () => {
            if (oldAccount) {
              oldEmbeddingStarted();
              await oldEmbeddingGate;
            }
            return [0.1, 0.2, 0.3];
          }),
          embedBatch: vi.fn(async () => [[0.1, 0.2, 0.3]]),
          close: oldAccount ? closeOldProvider : closeReplacementProvider,
        },
      };
    });
    providerMocks.getMemoryEmbeddingProvider.mockReturnValue({
      id: "openai",
      create: createProvider,
    });
    const api = {
      config,
      runtime: {
        config: { current: () => config },
        agent: { resolveAgentDir: () => agentDir },
      },
    } as unknown as OpenClawPluginApi;
    const embeddings = createEmbeddings(api);

    try {
      publishCredential("fixture-inflight-old");
      const firstEmbedding = embed(embeddings, "private", "old account request");
      await oldEmbeddingStart;

      publishCredential("fixture-inflight-new");
      const replacementEmbedding = embed(embeddings, "private", "new account request");
      await Promise.resolve();
      expect(createProvider).toHaveBeenCalledOnce();
      expect(closeOldProvider).not.toHaveBeenCalled();

      releaseOldEmbedding();
      await expect(Promise.all([firstEmbedding, replacementEmbedding])).resolves.toEqual([
        [0.1, 0.2, 0.3],
        [0.1, 0.2, 0.3],
      ]);
      expect(closeOldProvider).toHaveBeenCalledOnce();
      expect(createProvider).toHaveBeenCalledTimes(2);
      expect(
        expectDefined(closeOldProvider.mock.invocationCallOrder[0], "old account close order"),
      ).toBeLessThan(
        expectDefined(createProvider.mock.invocationCallOrder[1], "new account create order"),
      );
    } finally {
      releaseOldEmbedding();
      await embeddings.close?.();
      clearRuntimeAuthProfileStoreSnapshots();
    }

    expect(closeReplacementProvider).toHaveBeenCalledOnce();
  });

  it("queues replacement behind close intent while provider creation is pending", async () => {
    let releaseFirstCreate: () => void = () => {};
    const firstCreateGate = new Promise<void>((resolve) => {
      releaseFirstCreate = resolve;
    });
    const closeProvider = vi.fn(async () => {});
    const createProvider = vi.fn(async () => {
      if (createProvider.mock.calls.length === 1) {
        await firstCreateGate;
      }
      return {
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embedQuery: vi.fn(async () => [0.1, 0.2, 0.3]),
          embedBatch: vi.fn(async () => [[0.1, 0.2, 0.3]]),
          close: closeProvider,
        },
      };
    });
    providerMocks.getMemoryEmbeddingProvider.mockReturnValue({
      id: "openai",
      create: createProvider,
    });

    const first = createEmbeddings(createApi());
    const firstEmbed = embed(first, "main", "first");
    await vi.waitFor(() => expect(createProvider).toHaveBeenCalledTimes(1));

    const closePromise = first.close?.();
    const replacement = createEmbeddings(createApi());
    const replacementEmbed = embed(replacement, "main", "replacement");
    await Promise.resolve();
    expect(createProvider).toHaveBeenCalledTimes(1);

    releaseFirstCreate();
    await firstEmbed;
    await closePromise;
    await replacementEmbed;

    expect(closeProvider).toHaveBeenCalledTimes(1);
    expect(createProvider).toHaveBeenCalledTimes(2);
    expect(
      expectDefined(closeProvider.mock.invocationCallOrder[0], "pending provider close order"),
    ).toBeLessThan(
      expectDefined(createProvider.mock.invocationCallOrder[1], "replacement create order"),
    );
    await replacement.close?.();
  });

  it("does not re-close a provider retired while an older provider still fails", async () => {
    const closeOlder = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("older close failed once"))
      .mockRejectedValueOnce(new Error("older close failed twice"))
      .mockResolvedValue(undefined);
    const closeCurrent = vi.fn(async () => {});
    const createProvider = vi
      .fn()
      .mockResolvedValueOnce({
        provider: {
          id: "openai",
          model: "older",
          embedQuery: vi.fn(async () => [0.1]),
          embedBatch: vi.fn(async () => [[0.1]]),
          close: closeOlder,
        },
      })
      .mockResolvedValueOnce({
        provider: {
          id: "openai",
          model: "current",
          embedQuery: vi.fn(async () => [0.2]),
          embedBatch: vi.fn(async () => [[0.2]]),
          close: closeCurrent,
        },
      });
    providerMocks.getMemoryEmbeddingProvider.mockReturnValue({
      id: "openai",
      create: createProvider,
    });

    const older = createEmbeddings(createApi());
    const current = createEmbeddings(createApi());
    await embed(older, "main", "older");
    await embed(current, "main", "current");

    await expect(older.close?.()).rejects.toThrow("older close failed once");
    await expect(current.close?.()).rejects.toThrow("older close failed twice");
    expect(closeCurrent).toHaveBeenCalledTimes(1);

    await expect(current.close?.()).resolves.toBeUndefined();
    expect(closeOlder).toHaveBeenCalledTimes(3);
    expect(closeCurrent).toHaveBeenCalledTimes(1);
  });

  it("drains an admitted embedding before provider close", async () => {
    let markEmbedStarted: () => void = () => {};
    const embedStarted = new Promise<void>((resolve) => {
      markEmbedStarted = resolve;
    });
    let releaseEmbed: () => void = () => {};
    const embedGate = new Promise<void>((resolve) => {
      releaseEmbed = resolve;
    });
    const closeProvider = vi.fn(async () => {});
    providerMocks.getMemoryEmbeddingProvider.mockReturnValue({
      id: "openai",
      create: vi.fn(async () => ({
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embedQuery: vi.fn(async () => {
            markEmbedStarted();
            await embedGate;
            return [0.1, 0.2, 0.3];
          }),
          embedBatch: vi.fn(async () => [[0.1, 0.2, 0.3]]),
          close: closeProvider,
        },
      })),
    });

    const embeddings = createEmbeddings(createApi());
    const embedPromise = embed(embeddings, "main", "active");
    await embedStarted;
    const closePromise = embeddings.close?.();
    await Promise.resolve();

    expect(closeProvider).not.toHaveBeenCalled();
    await expect(embed(embeddings, "main", "late")).rejects.toThrow(
      "memory-lancedb embeddings are closed",
    );

    releaseEmbed();
    await expect(embedPromise).resolves.toEqual([0.1, 0.2, 0.3]);
    await closePromise;
    expect(closeProvider).toHaveBeenCalledTimes(1);
  });
});
