// Verifies memory-search config resolution across providers, sync, and batching.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveRememberAcrossConversations } from "../memory-host-sdk/host/config-utils.js";
import {
  clearEmbeddingProviders,
  listRegisteredEmbeddingProviders,
  registerEmbeddingProvider,
  restoreRegisteredEmbeddingProviders,
  type RegisteredEmbeddingProvider,
} from "../plugins/embedding-providers.js";
import {
  clearMemoryEmbeddingProviders,
  registerMemoryEmbeddingProvider,
} from "../plugins/memory-embedding-providers.js";
import {
  SecretSurfaceUnavailableError,
  setActiveDegradedSecretOwners,
} from "../secrets/runtime-degraded-state.js";
import { runtimeMemorySecretOwnerId } from "../secrets/runtime-memory-secret-owner.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { resolveMemorySearchConfig, resolveMemorySearchSyncConfig } from "./memory-search.js";

const asConfig = (cfg: OpenClawConfig): OpenClawConfig => ({
  ...cfg,
  // Provider registries are supplied explicitly below; plugin loading belongs
  // to its integration tests and would turn these pure config cases into cold scans.
  plugins: cfg.plugins ?? { enabled: false },
});
let registeredEmbeddingProvidersSnapshot: RegisteredEmbeddingProvider[];

function registerBaseMemoryEmbeddingProviders(options?: { includeGemini?: boolean }): void {
  // Register provider contracts locally so config tests do not depend on the
  // plugin loader or live embedding backends.
  registerMemoryEmbeddingProvider({
    id: "openai",
    defaultModel: "text-embedding-3-small",
    transport: "remote",
    create: async () => ({ provider: null }),
  });
  registerMemoryEmbeddingProvider({
    id: "local",
    defaultModel: "local-default",
    transport: "local",
    create: async () => ({ provider: null }),
  });
  if (options?.includeGemini !== false) {
    registerMemoryEmbeddingProvider({
      id: "gemini",
      defaultModel: "gemini-embedding-001",
      transport: "remote",
      supportsMultimodalEmbeddings: ({ model }) =>
        model
          .trim()
          .replace(/^models\//, "")
          .replace(/^(gemini|google)\//, "") === "gemini-embedding-2-preview",
      create: async () => ({ provider: null }),
    });
  }
  registerMemoryEmbeddingProvider({
    id: "voyage",
    defaultModel: "voyage-4-large",
    transport: "remote",
    create: async () => ({ provider: null }),
  });
  registerMemoryEmbeddingProvider({
    id: "mistral",
    defaultModel: "mistral-embed",
    transport: "remote",
    create: async () => ({ provider: null }),
  });
  registerMemoryEmbeddingProvider({
    id: "lmstudio",
    defaultModel: "text-embedding-nomic-embed-text-v1.5",
    transport: "remote",
    create: async () => ({ provider: null }),
  });
  registerMemoryEmbeddingProvider({
    id: "ollama",
    defaultModel: "nomic-embed-text",
    transport: "remote",
    create: async () => ({ provider: null }),
  });
}

describe("memory search config", () => {
  beforeEach(() => {
    registeredEmbeddingProvidersSnapshot = listRegisteredEmbeddingProviders();
    clearEmbeddingProviders();
    clearMemoryEmbeddingProviders();
    registerBaseMemoryEmbeddingProviders();
  });

  afterEach(() => {
    setActiveDegradedSecretOwners([]);
    clearMemoryEmbeddingProviders();
    restoreRegisteredEmbeddingProviders(registeredEmbeddingProvidersSnapshot);
  });

  function configWithDefaultProvider(provider: string): OpenClawConfig {
    return asConfig({
      memory: {
        search: {
          provider,
        },
      },

      agents: {
        defaults: {},
      },
    });
  }

  function expectDefaultRemoteBatch(resolved: ReturnType<typeof resolveMemorySearchConfig>): void {
    // Remote providers default to non-batch mode; explicit batch config must
    // opt in so memory search does not introduce hidden async polling.
    expect(resolved?.remote?.batch).toEqual({
      enabled: false,
      wait: true,
      concurrency: 2,
      pollIntervalMs: 2000,
      timeoutMinutes: 60,
    });
  }

  function expectEmptyMultimodalConfig(resolved: ReturnType<typeof resolveMemorySearchConfig>) {
    expect(resolved?.multimodal).toEqual({
      enabled: true,
      modalities: [],
      maxFileBytes: 10 * 1024 * 1024,
    });
  }

  function configWithRemoteDefaults(remote: Record<string, unknown>) {
    return asConfig({
      memory: {
        search: {
          provider: "openai",
          remote,
        },
      },

      agents: {
        defaults: {},
        list: [
          {
            id: "main",
            default: true,
            memory: {
              search: {
                remote: {
                  baseUrl: "https://agent.example/v1",
                },
              },
            },
          },
        ],
      },
    });
  }

  function expectMergedRemoteConfig(
    resolved: ReturnType<typeof resolveMemorySearchConfig>,
    apiKey: unknown,
  ) {
    expect(resolved?.remote).toEqual({
      baseUrl: "https://agent.example/v1",
      apiKey,
      headers: { "X-Default": "on" },
      batch: {
        enabled: false,
        wait: true,
        concurrency: 2,
        pollIntervalMs: 2000,
        timeoutMinutes: 60,
      },
    });
  }

  it("returns null when disabled", () => {
    const cfg = asConfig({
      memory: { search: { enabled: true } },

      agents: {
        defaults: {},
        list: [
          {
            id: "main",
            default: true,
            memory: { search: { enabled: false } },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved).toBeNull();
  });

  it("throws the typed unavailable error only for the degraded agent owner", () => {
    const cfg = asConfig({
      agents: {
        list: [{ id: "cold" }, { id: "healthy" }],
      },
    });
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: runtimeMemorySecretOwnerId("cold"),
        state: "unavailable",
        paths: ["memory.search.remote.apiKey"],
        refKeys: ["env:default:MISSING_MEMORY_KEY"],
        reason: "secret reference was not found",
      },
    ]);

    expect(() => resolveMemorySearchConfig(cfg, "cold")).toThrow(SecretSurfaceUnavailableError);
    expect(resolveMemorySearchConfig(cfg, "healthy")?.enabled).toBe(true);
  });

  it("returns null sync config when disabled", () => {
    const cfg = asConfig({
      memory: { search: { enabled: true } },

      agents: {
        defaults: {},
        list: [
          {
            id: "main",
            default: true,
            memory: { search: { enabled: false } },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchSyncConfig(cfg, "main");
    expect(resolved).toBeNull();
  });

  it.each([
    { name: "unset with main scope", cfg: {}, expected: true },
    {
      name: "unset with per-channel-peer scope",
      cfg: { session: { dmScope: "per-channel-peer" } },
      expected: false,
    },
    {
      name: "unset with main scope and a binding override",
      cfg: {
        session: { dmScope: "main" },
        bindings: [
          {
            agentId: "main",
            match: { channel: "telegram" },
            session: { dmScope: "per-peer" },
          },
        ],
      },
      expected: false,
    },
    {
      name: "explicit false with main scope",
      cfg: {
        session: { dmScope: "main" },
        memory: { search: { rememberAcrossConversations: false } },

        agents: { defaults: {} },
      },
      expected: false,
    },
    {
      name: "explicit true with per-peer scope",
      cfg: {
        session: { dmScope: "per-peer" },
        memory: { search: { rememberAcrossConversations: true } },

        agents: { defaults: {} },
      },
      expected: true,
    },
  ])("resolves remember-across-conversations for $name", ({ cfg, expected }) => {
    expect(resolveRememberAcrossConversations(asConfig(cfg as OpenClawConfig), "main")).toBe(
      expected,
    );
  });

  it("enables cross-conversation recall by default for a personal install", () => {
    const resolved = resolveMemorySearchConfig(asConfig({}), "main");

    expect(resolved?.rememberAcrossConversations).toBe(true);
    expect(resolved?.experimental.sessionMemory).toBe(true);
    expect(resolved?.sources).toEqual(["memory", "sessions"]);
  });

  it("keeps cross-conversation recall off by default for isolated DMs", () => {
    const resolved = resolveMemorySearchConfig(
      asConfig({ session: { dmScope: "per-channel-peer" } }),
      "main",
    );

    expect(resolved?.rememberAcrossConversations).toBe(false);
    expect(resolved?.experimental.sessionMemory).toBe(false);
    expect(resolved?.sources).toEqual(["memory"]);
  });

  it("enables transcript indexing for an opted-in agent", () => {
    const cfg = asConfig({
      agents: {
        list: [
          {
            id: "personal",
            memory: { search: { rememberAcrossConversations: true } },
          },
        ],
      },
    });

    const resolved = resolveMemorySearchConfig(cfg, "personal");

    expect(resolved?.rememberAcrossConversations).toBe(true);
    expect(resolved?.experimental.sessionMemory).toBe(true);
    expect(resolved?.sources).toEqual(["memory", "sessions"]);
    expect(resolved?.searchSources).toEqual(["memory"]);
  });

  it("preserves explicitly configured transcript search for an opted-in agent", () => {
    const cfg = asConfig({
      agents: {
        list: [
          {
            id: "personal",
            memory: {
              search: {
                rememberAcrossConversations: true,
                sources: ["sessions"],
              },
            },
          },
        ],
      },
    });

    const resolved = resolveMemorySearchConfig(cfg, "personal");

    expect(resolved?.sources).toEqual(["sessions"]);
    expect(resolved?.searchSources).toEqual(["sessions"]);
  });

  it("lets a per-agent false override a default true", () => {
    const cfg = asConfig({
      memory: { search: { rememberAcrossConversations: true } },

      agents: {
        defaults: {},
        list: [
          {
            id: "shared",
            memory: { search: { rememberAcrossConversations: false } },
          },
        ],
      },
    });

    const resolved = resolveMemorySearchConfig(cfg, "shared");

    expect(resolved?.rememberAcrossConversations).toBe(false);
    expect(resolved?.experimental.sessionMemory).toBe(false);
    expect(resolved?.sources).toEqual(["memory"]);
  });

  it("defaults provider to openai when unspecified", () => {
    const cfg = asConfig({
      memory: {
        search: {
          enabled: true,
        },
      },

      agents: {
        defaults: {},
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.provider).toBe("openai");
    expect(resolved?.model).toBe("text-embedding-3-small");
    expect(resolved?.fallback).toBe("none");
    expect(resolved?.store.databasePath).toBe(resolveOpenClawAgentSqlitePath({ agentId: "main" }));
  });

  it("normalizes legacy auto provider config to openai", () => {
    const resolved = resolveMemorySearchConfig(configWithDefaultProvider("auto"), "main");

    expect(resolved?.provider).toBe("openai");
    expect(resolved?.model).toBe("text-embedding-3-small");
  });

  it("resolves explicit concrete providers", () => {
    const resolved = resolveMemorySearchConfig(configWithDefaultProvider("openai"), "main");

    expect(resolved?.provider).toBe("openai");
  });

  it("resolves explicit local providers", () => {
    const resolved = resolveMemorySearchConfig(configWithDefaultProvider("local"), "main");

    expect(resolved?.provider).toBe("local");
  });

  it("resolves providers from the generic embedding provider registry", () => {
    registerEmbeddingProvider({
      id: "generic-local",
      defaultModel: "local-gguf-default",
      transport: "local",
      create: async () => ({ provider: null }),
    });

    const resolved = resolveMemorySearchConfig(configWithDefaultProvider("generic-local"), "main");

    expect(resolved?.provider).toBe("generic-local");
    expect(resolved?.model).toBe("local-gguf-default");
    expect(resolved?.remote).toBeUndefined();
  });

  it("resolves explicit provider-none", () => {
    const resolved = resolveMemorySearchConfig(
      asConfig({
        plugins: { enabled: true },
        memory: { search: { provider: "none", fallback: "deepinfra" } },

        agents: {
          defaults: {},
        },
      }),
      "main",
    );

    expect(resolved?.provider).toBe("none");
  });

  it("skips multimodal provider discovery for provider-none", () => {
    const resolved = resolveMemorySearchConfig(
      asConfig({
        plugins: { enabled: true },
        memory: {
          search: {
            provider: "none",
            multimodal: { enabled: true, modalities: ["image"] },
          },
        },

        agents: {
          defaults: {},
        },
      }),
      "main",
    );

    expect(resolved?.provider).toBe("none");
    expect(resolved?.multimodal.modalities).toEqual(["image"]);
  });

  it("resolves custom provider ids through their configured api owner", () => {
    // Workspace provider aliases inherit embedding defaults from their API
    // owner while keeping the configured provider id for auth/routing.
    const cfg = asConfig({
      models: {
        providers: {
          "ollama-5080": {
            api: "ollama",
            baseUrl: "http://10.0.0.8:11435",
            models: [],
          },
        },
      },
      memory: {
        search: {
          provider: "ollama-5080",
        },
      },

      agents: {
        defaults: {},
      },
    });

    const resolved = resolveMemorySearchConfig(cfg, "main");

    expect(resolved?.provider).toBe("ollama-5080");
    expect(resolved?.model).toBe("nomic-embed-text");
    expectDefaultRemoteBatch(resolved);
  });

  it("resolves fixed sync defaults without consulting embedding providers", () => {
    clearMemoryEmbeddingProviders();
    const cfg = asConfig({
      memory: {
        search: {
          provider: "openai",
        },
      },

      agents: {
        defaults: {},
      },
    });

    expect(resolveMemorySearchSyncConfig(cfg, "main")).toEqual({
      onSessionStart: true,
      onSearch: true,
      watch: true,
      watchDebounceMs: 1500,
      intervalMinutes: 0,
      embeddingBatchTimeoutSeconds: undefined,
      sessions: {
        deltaBytes: 100_000,
        deltaMessages: 50,
        postCompactionForce: true,
      },
    });
  });

  it("keeps the fixed embedding batch timeout unset", () => {
    const cfg = asConfig({
      memory: {
        search: {
          provider: "openai",
        },
      },

      agents: {
        defaults: {},
      },
    });

    expect(
      resolveMemorySearchSyncConfig(cfg, "main")?.embeddingBatchTimeoutSeconds,
    ).toBeUndefined();
  });

  it("merges defaults and overrides", () => {
    const cfg = asConfig({
      memory: {
        search: {
          provider: "openai",
          model: "text-embedding-3-small",
          store: {
            vector: {
              extensionPath: "/opt/sqlite-vec.dylib",
            },
          },
          query: { maxResults: 4, minScore: 0.2 },
        },
      },

      agents: {
        defaults: {},
        list: [
          {
            id: "main",
            default: true,
            memory: {
              search: {
                query: { maxResults: 8 },
              },
            },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.provider).toBe("openai");
    expect(resolved?.model).toBe("text-embedding-3-small");
    expect(resolved?.query.maxResults).toBe(8);
    expect(resolved?.query.minScore).toBe(0.2);
    expect(resolved?.store.vector.enabled).toBe(true);
    expect(resolved?.store.vector.extensionPath).toBe("/opt/sqlite-vec.dylib");
  });

  it("merges extra memory paths from defaults and overrides", () => {
    const cfg = asConfig({
      memory: {
        search: {
          extraPaths: ["/shared/notes", " docs "],
        },
      },

      agents: {
        defaults: {},
        list: [
          {
            id: "main",
            default: true,
            memory: {
              search: {
                extraPaths: ["/shared/notes", "../team-notes"],
              },
            },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.extraPaths).toEqual(["/shared/notes", "docs", "../team-notes"]);
  });

  it("normalizes multimodal settings", () => {
    const cfg = asConfig({
      memory: {
        search: {
          provider: "gemini",
          model: "gemini-embedding-2-preview",
          multimodal: {
            enabled: true,
            modalities: ["all"],
            maxFileBytes: 8192,
          },
        },
      },

      agents: {
        defaults: {},
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.multimodal).toEqual({
      enabled: true,
      modalities: ["image", "audio"],
      maxFileBytes: 8192,
    });
  });

  it("keeps an explicit empty multimodal modalities list empty", () => {
    const cfg = asConfig({
      memory: {
        search: {
          provider: "gemini",
          model: "gemini-embedding-2-preview",
          multimodal: {
            enabled: true,
            modalities: [],
          },
        },
      },

      agents: {
        defaults: {},
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectEmptyMultimodalConfig(resolved);
    expect(resolved?.provider).toBe("gemini");
  });

  it("does not enforce multimodal provider validation when no modalities are active", () => {
    const cfg = asConfig({
      memory: {
        search: {
          provider: "openai",
          model: "text-embedding-3-small",
          fallback: "openai",
          multimodal: {
            enabled: true,
            modalities: [],
          },
        },
      },

      agents: {
        defaults: {},
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectEmptyMultimodalConfig(resolved);
  });

  it("rejects multimodal memory on unsupported providers", () => {
    const cfg = asConfig({
      memory: {
        search: {
          provider: "openai",
          model: "text-embedding-3-small",
          multimodal: { enabled: true, modalities: ["image"] },
        },
      },

      agents: {
        defaults: {},
      },
    });
    expect(() => resolveMemorySearchConfig(cfg, "main")).toThrow(
      /memory\.search\.multimodal requires a provider adapter that supports multimodal embeddings/,
    );
  });

  it("rejects multimodal memory on generic OpenAI-compatible providers", () => {
    const cfg = asConfig({
      memory: {
        search: {
          provider: "openai-compatible",
          model: "text-embedding-bge-m3",
          remote: { baseUrl: "http://127.0.0.1:1234/v1" },
          multimodal: { enabled: true, modalities: ["image"] },
        },
      },

      agents: {
        defaults: {},
      },
    });
    expect(() => resolveMemorySearchConfig(cfg, "main")).toThrow(
      /memory\.search\.multimodal requires a provider adapter that supports multimodal embeddings/,
    );
  });

  it("rejects multimodal memory on baseUrl-only OpenAI-compatible custom providers", () => {
    const cfg = asConfig({
      models: {
        providers: {
          localEmbeddings: {
            baseUrl: "http://127.0.0.1:1234/v1",
            models: [],
          },
        },
      },
      memory: {
        search: {
          provider: "localEmbeddings",
          model: "text-embedding-bge-m3",
          multimodal: { enabled: true, modalities: ["image"] },
        },
      },

      agents: {
        defaults: {},
      },
    });
    expect(() => resolveMemorySearchConfig(cfg, "main")).toThrow(
      /memory\.search\.multimodal requires a provider adapter that supports multimodal embeddings/,
    );
  });

  it("accepts Gemini multimodal memory even when the runtime registry has not registered Gemini yet", () => {
    clearMemoryEmbeddingProviders();
    registerBaseMemoryEmbeddingProviders({ includeGemini: false });
    const cfg = asConfig({
      memory: {
        search: {
          provider: "gemini",
          model: "gemini-embedding-2-preview",
          multimodal: { enabled: true, modalities: ["image"] },
        },
      },

      agents: {
        defaults: {},
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.provider).toBe("gemini");
    expect(resolved?.multimodal).toEqual({
      enabled: true,
      modalities: ["image"],
      maxFileBytes: 10 * 1024 * 1024,
    });
  });

  it("rejects multimodal memory when fallback is configured", () => {
    const cfg = asConfig({
      memory: {
        search: {
          provider: "gemini",
          model: "gemini-embedding-2-preview",
          fallback: "openai",
          multimodal: { enabled: true, modalities: ["image"] },
        },
      },

      agents: {
        defaults: {},
      },
    });
    expect(() => resolveMemorySearchConfig(cfg, "main")).toThrow(
      /memory\.search\.multimodal does not support memory\.search\.fallback/,
    );
  });

  it("includes batch defaults for openai without remote overrides", () => {
    const cfg = configWithDefaultProvider("openai");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectDefaultRemoteBatch(resolved);
  });

  it("keeps remote unset for local provider without overrides", () => {
    const cfg = configWithDefaultProvider("local");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.remote).toBeUndefined();
  });

  it("includes remote defaults for gemini without overrides", () => {
    const cfg = configWithDefaultProvider("gemini");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectDefaultRemoteBatch(resolved);
  });

  it("includes remote defaults and model default for mistral without overrides", () => {
    const cfg = configWithDefaultProvider("mistral");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectDefaultRemoteBatch(resolved);
    expect(resolved?.model).toBe("mistral-embed");
  });

  it("includes remote defaults and model default for lmstudio without overrides", () => {
    const cfg = configWithDefaultProvider("lmstudio");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectDefaultRemoteBatch(resolved);
    expect(resolved?.model).toBe("text-embedding-nomic-embed-text-v1.5");
  });

  it("includes remote defaults and model default for ollama without overrides", () => {
    const cfg = configWithDefaultProvider("ollama");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectDefaultRemoteBatch(resolved);
    expect(resolved?.model).toBe("nomic-embed-text");
  });

  it("merges memory search input_type overrides", () => {
    const cfg = asConfig({
      memory: {
        search: {
          provider: "openai",
          inputType: "passage",
          queryInputType: "query",
        },
      },

      agents: {
        defaults: {},
        list: [
          {
            id: "main",
            default: true,
            memory: {
              search: {
                documentInputType: "document",
              },
            },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.inputType).toBe("passage");
    expect(resolved?.queryInputType).toBe("query");
    expect(resolved?.documentInputType).toBe("document");
  });

  it("defaults session delta thresholds", () => {
    const cfg = asConfig({
      memory: {
        search: {
          provider: "openai",
        },
      },

      agents: {
        defaults: {},
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.sync.sessions).toEqual({
      deltaBytes: 100000,
      deltaMessages: 50,
      postCompactionForce: true,
    });
  });

  it("merges remote defaults with agent overrides", () => {
    const cfg = configWithRemoteDefaults({
      baseUrl: "https://default.example/v1",
      apiKey: "default-key", // pragma: allowlist secret
      headers: { "X-Default": "on" },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectMergedRemoteConfig(resolved, "default-key"); // pragma: allowlist secret
  });

  it("ignores retired remote non-batch concurrency", () => {
    const cfg = configWithRemoteDefaults({
      apiKey: "default-key", // pragma: allowlist secret
      headers: { "X-Default": "on" },
      nonBatchConcurrency: 1,
    });

    const resolved = resolveMemorySearchConfig(cfg, "main");

    expectMergedRemoteConfig(resolved, "default-key"); // pragma: allowlist secret
  });

  it("preserves SecretRef remote apiKey when merging defaults with agent overrides", () => {
    const cfg = configWithRemoteDefaults({
      apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" }, // pragma: allowlist secret
      headers: { "X-Default": "on" },
    });

    const resolved = resolveMemorySearchConfig(cfg, "main");

    expectMergedRemoteConfig(resolved, {
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
  });

  it("gates session sources behind rememberAcrossConversations", () => {
    const cfg = asConfig({
      memory: {
        search: {
          provider: "openai",
          sources: ["memory", "sessions"],
        },
      },

      agents: {
        defaults: {},
        list: [
          {
            id: "main",
            default: true,
            memory: {
              search: {
                rememberAcrossConversations: false,
              },
            },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.sources).toEqual(["memory"]);
  });

  it("allows session sources when cross-conversation recall is enabled", () => {
    const cfg = asConfig({
      memory: {
        search: {
          provider: "openai",
          sources: ["memory", "sessions"],
          rememberAcrossConversations: true,
        },
      },

      agents: {
        defaults: {},
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.sources).toContain("sessions");
  });
});
