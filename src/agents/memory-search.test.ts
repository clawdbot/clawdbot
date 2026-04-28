import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearMemoryEmbeddingProviders,
  registerMemoryEmbeddingProvider,
} from "../plugins/memory-embedding-providers.js";
import { resolveMemorySearchConfig, resolveMemorySearchSyncConfig } from "./memory-search.js";

const asConfig = (cfg: OpenClawConfig): OpenClawConfig => cfg;

function registerBaseMemoryEmbeddingProviders(options?: { includeGemini?: boolean }): void {
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
    clearMemoryEmbeddingProviders();
    registerBaseMemoryEmbeddingProviders();
  });

  afterEach(() => {
    clearMemoryEmbeddingProviders();
  });

  function configWithDefaultProvider(provider: string): OpenClawConfig {
    return asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider,
          },
        },
      },
    });
  }

  function expectDefaultRemoteBatch(resolved: ReturnType<typeof resolveMemorySearchConfig>): void {
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
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            remote,
          },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: {
              remote: {
                baseUrl: "https://agent.example/v1",
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
    extras?: { nonBatchConcurrency?: number },
  ) {
    expect(resolved?.remote).toEqual({
      baseUrl: "https://agent.example/v1",
      apiKey,
      headers: { "X-Default": "on" },
      ...(typeof extras?.nonBatchConcurrency === "number"
        ? { nonBatchConcurrency: extras.nonBatchConcurrency }
        : {}),
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
      agents: {
        defaults: {
          memorySearch: { enabled: true },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: { enabled: false },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved).toBeNull();
  });

  it("returns null sync config when disabled", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: { enabled: true },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: { enabled: false },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchSyncConfig(cfg, "main");
    expect(resolved).toBeNull();
  });

  it("defaults provider to auto when unspecified", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.provider).toBe("auto");
    expect(resolved?.fallback).toBe("none");
  });

  it("resolves custom provider ids through their configured api owner", () => {
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
      agents: {
        defaults: {
          memorySearch: {
            provider: "ollama-5080",
          },
        },
      },
    });

    const resolved = resolveMemorySearchConfig(cfg, "main");

    expect(resolved?.provider).toBe("ollama-5080");
    expect(resolved?.model).toBe("nomic-embed-text");
    expectDefaultRemoteBatch(resolved);
  });

  it("resolves sync config without consulting embedding providers", () => {
    clearMemoryEmbeddingProviders();
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            sync: {
              onSessionStart: false,
              onSearch: true,
              watch: false,
              watchDebounceMs: 25,
              intervalMinutes: 3,
              sessions: {
                deltaBytes: 321,
                deltaMessages: 7,
                postCompactionForce: false,
              },
            },
          },
        },
      },
    });

    expect(resolveMemorySearchSyncConfig(cfg, "main")).toEqual({
      onSessionStart: false,
      onSearch: true,
      watch: false,
      watchDebounceMs: 25,
      intervalMinutes: 3,
      embeddingBatchTimeoutSeconds: undefined,
      sessions: {
        deltaBytes: 321,
        deltaMessages: 7,
        postCompactionForce: false,
      },
    });
  });

  it("uses configured embeddingBatchTimeoutSeconds when set", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            sync: {
              embeddingBatchTimeoutSeconds: 600,
            },
          },
        },
      },
    });

    expect(resolveMemorySearchSyncConfig(cfg, "main")?.embeddingBatchTimeoutSeconds).toBe(600);
  });

  it("merges defaults and overrides", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: {
              vector: {
                enabled: false,
                extensionPath: "/opt/sqlite-vec.dylib",
              },
            },
            chunking: { tokens: 500, overlap: 100 },
            query: { maxResults: 4, minScore: 0.2 },
          },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: {
              chunking: { tokens: 320 },
              query: { maxResults: 8 },
              store: {
                vector: {
                  enabled: true,
                },
              },
            },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.provider).toBe("openai");
    expect(resolved?.model).toBe("text-embedding-3-small");
    expect(resolved?.chunking.tokens).toBe(320);
    expect(resolved?.chunking.overlap).toBe(100);
    expect(resolved?.query.maxResults).toBe(8);
    expect(resolved?.query.minScore).toBe(0.2);
    expect(resolved?.store.vector.enabled).toBe(true);
    expect(resolved?.store.vector.extensionPath).toBe("/opt/sqlite-vec.dylib");
  });

  it("merges extra memory paths from defaults and overrides", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            extraPaths: ["/shared/notes", " docs "],
          },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: {
              extraPaths: ["/shared/notes", "../team-notes"],
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
      agents: {
        defaults: {
          memorySearch: {
            provider: "gemini",
            model: "gemini-embedding-2-preview",
            multimodal: {
              enabled: true,
              modalities: ["all"],
              maxFileBytes: 8192,
            },
          },
        },
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
      agents: {
        defaults: {
          memorySearch: {
            provider: "gemini",
            model: "gemini-embedding-2-preview",
            multimodal: {
              enabled: true,
              modalities: [],
            },
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectEmptyMultimodalConfig(resolved);
    expect(resolved?.provider).toBe("gemini");
  });

  it("does not enforce multimodal provider validation when no modalities are active", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            fallback: "openai",
            multimodal: {
              enabled: true,
              modalities: [],
            },
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectEmptyMultimodalConfig(resolved);
  });

  it("rejects multimodal memory on unsupported providers", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            multimodal: { enabled: true, modalities: ["image"] },
          },
        },
      },
    });
    expect(() => resolveMemorySearchConfig(cfg, "main")).toThrow(
      /memorySearch\.multimodal requires a provider adapter that supports multimodal embeddings/,
    );
  });

  it("accepts Gemini multimodal memory even when the runtime registry has not registered Gemini yet", () => {
    clearMemoryEmbeddingProviders();
    registerBaseMemoryEmbeddingProviders({ includeGemini: false });
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "gemini",
            model: "gemini-embedding-2-preview",
            multimodal: { enabled: true, modalities: ["image"] },
          },
        },
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
      agents: {
        defaults: {
          memorySearch: {
            provider: "gemini",
            model: "gemini-embedding-2-preview",
            fallback: "openai",
            multimodal: { enabled: true, modalities: ["image"] },
          },
        },
      },
    });
    expect(() => resolveMemorySearchConfig(cfg, "main")).toThrow(
      /memorySearch\.multimodal does not support memorySearch\.fallback/,
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
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            inputType: "passage",
            queryInputType: "query",
          },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: {
              documentInputType: "document",
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
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
          },
        },
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

  it("merges remote non-batch concurrency from defaults with agent overrides", () => {
    const cfg = configWithRemoteDefaults({
      apiKey: "default-key", // pragma: allowlist secret
      headers: { "X-Default": "on" },
      nonBatchConcurrency: 1,
    });

    const resolved = resolveMemorySearchConfig(cfg, "main");

    expectMergedRemoteConfig(resolved, "default-key", { nonBatchConcurrency: 1 }); // pragma: allowlist secret
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

  it("gates session sources behind experimental flag", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            sources: ["memory", "sessions"],
          },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: {
              experimental: { sessionMemory: false },
            },
          },
        ],
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.sources).toEqual(["memory"]);
  });

  it("allows session sources when experimental flag is enabled", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            sources: ["memory", "sessions"],
            experimental: { sessionMemory: true },
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.sources).toContain("sessions");
  });
});
