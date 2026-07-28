// Memory Core tests cover manager reindex state plugin behavior.
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import {
  resolveConfiguredScopeHash,
  resolveConfiguredSourcesForMeta,
  resolveMemoryIndexProviderIdentities,
  resolveMemoryIndexIdentityState,
  type MemoryIndexMeta,
} from "./manager-reindex-state.js";

function createMeta(overrides: Partial<MemoryIndexMeta> = {}): MemoryIndexMeta {
  return {
    model: "mock-embed-v1",
    provider: "openai",
    providerKey: "provider-key-v1",
    sources: ["memory"],
    scopeHash: "scope-v1",
    chunkTokens: 4000,
    chunkOverlap: 0,
    ftsTokenizer: "unicode61",
    ...overrides,
  };
}

function createIdentityParams(
  overrides: {
    meta?: MemoryIndexMeta | null;
    provider?: { id: string; model: string } | null;
    providerKey?: string;
    providerAliases?: Array<{ model: string; providerKey: string }>;
    providerKeyKnown?: boolean;
    configuredSources?: MemorySource[];
    configuredScopeHash?: string;
    chunkTokens?: number;
    chunkOverlap?: number;
    vectorReady?: boolean;
    hasIndexedChunks?: boolean;
    ftsTokenizer?: string;
  } = {},
) {
  return {
    meta: createMeta(),
    provider: { id: "openai", model: "mock-embed-v1" },
    providerKey: "provider-key-v1",
    configuredSources: ["memory"] as MemorySource[],
    configuredScopeHash: "scope-v1",
    chunkTokens: 4000,
    chunkOverlap: 0,
    vectorReady: false,
    hasIndexedChunks: true,
    ftsTokenizer: "unicode61",
    ...overrides,
  };
}

function isMemoryIndexIdentityDirty(
  params: Parameters<typeof resolveMemoryIndexIdentityState>[0],
): boolean {
  return resolveMemoryIndexIdentityState(params).status !== "valid";
}

describe("memory reindex state", () => {
  it("retains the primary provider identity when its model is empty", () => {
    expect(
      resolveMemoryIndexProviderIdentities({
        provider: { id: "empty-model-provider", model: "" },
      }),
    ).toMatchObject([{ provider: "empty-model-provider", model: "" }]);
  });

  it("marks identity dirty when the embedding model changes", () => {
    expect(
      isMemoryIndexIdentityDirty(
        createIdentityParams({
          provider: { id: "openai", model: "mock-embed-v2" },
        }),
      ),
    ).toBe(true);
  });

  it("returns a mismatch reason when provider identity changes", () => {
    expect(
      resolveMemoryIndexIdentityState(
        createIdentityParams({
          provider: { id: "ollama", model: "mock-embed-v1" },
          providerKey: "provider-key-ollama",
        }),
      ),
    ).toEqual({
      status: "mismatched",
      reason: "index was built for provider openai, expected ollama",
    });
  });

  it("marks identity dirty when the provider cache key changes", () => {
    expect(
      isMemoryIndexIdentityDirty(
        createIdentityParams({
          provider: { id: "gemini", model: "gemini-embedding-2-preview" },
          providerKey: "provider-key-dims-768",
          meta: createMeta({
            provider: "gemini",
            model: "gemini-embedding-2-preview",
            providerKey: "provider-key-dims-3072",
          }),
        }),
      ),
    ).toBe(true);
  });

  it("can defer provider key comparison until provider initialization", () => {
    expect(
      resolveMemoryIndexIdentityState(
        createIdentityParams({
          providerKey: undefined,
          providerKeyKnown: false,
        }),
      ),
    ).toEqual({ status: "valid" });
  });

  it("keeps model identity strict when paths share a basename", () => {
    const indexedModel = "/models/default/model.gguf";
    const currentModel = "/models/custom/model.gguf";

    expect(
      resolveMemoryIndexIdentityState(
        createIdentityParams({
          provider: { id: "local", model: currentModel },
          providerKey: "provider-key-current",
          meta: createMeta({
            provider: "local",
            model: indexedModel,
            providerKey: "provider-key-indexed",
            vectorDims: 768,
          }),
          vectorReady: true,
        }),
      ),
    ).toEqual({
      status: "mismatched",
      reason: `index was built for model ${indexedModel}, expected ${currentModel}`,
    });
  });

  it("accepts only provider-declared model and provider-key alias pairs", () => {
    const alias = {
      model: "/models/default/model.gguf",
      providerKey: "provider-key-alias",
    };

    expect(
      resolveMemoryIndexIdentityState(
        createIdentityParams({
          provider: { id: "local", model: "hf:owner/default/model.gguf" },
          providerKey: "provider-key-current",
          providerAliases: [alias],
          meta: createMeta({
            provider: "local",
            model: alias.model,
            providerKey: alias.providerKey,
          }),
        }),
      ),
    ).toEqual({ status: "valid" });

    expect(
      resolveMemoryIndexIdentityState(
        createIdentityParams({
          provider: { id: "local", model: "hf:owner/default/model.gguf" },
          providerKey: "provider-key-current",
          providerAliases: [alias],
          meta: createMeta({
            provider: "local",
            model: alias.model,
            providerKey: "provider-key-arbitrary",
          }),
        }),
      ),
    ).toEqual({
      status: "mismatched",
      reason: "index provider settings changed",
    });
  });

  it("does not mark identity dirty for vector dimensions before chunks exist", () => {
    expect(
      resolveMemoryIndexIdentityState(
        createIdentityParams({
          vectorReady: true,
          hasIndexedChunks: false,
          meta: createMeta({ vectorDims: undefined }),
        }),
      ),
    ).toEqual({ status: "valid" });
  });

  it("marks identity dirty when extraPaths change", () => {
    const workspaceDir = "/tmp/workspace";
    const firstScopeHash = resolveConfiguredScopeHash({
      workspaceDir,
      extraPaths: ["/tmp/workspace/a"],
      multimodal: {
        enabled: false,
        modalities: [],
        maxFileBytes: 20 * 1024 * 1024,
      },
    });
    const secondScopeHash = resolveConfiguredScopeHash({
      workspaceDir,
      extraPaths: ["/tmp/workspace/b"],
      multimodal: {
        enabled: false,
        modalities: [],
        maxFileBytes: 20 * 1024 * 1024,
      },
    });

    expect(
      isMemoryIndexIdentityDirty(
        createIdentityParams({
          meta: createMeta({ scopeHash: firstScopeHash }),
          configuredScopeHash: secondScopeHash,
        }),
      ),
    ).toBe(true);
  });

  it("marks identity dirty when configured sources add sessions", () => {
    expect(
      isMemoryIndexIdentityDirty(
        createIdentityParams({
          configuredSources: ["memory", "sessions"],
        }),
      ),
    ).toBe(true);
  });

  it("marks identity dirty when multimodal settings change", () => {
    const workspaceDir = "/tmp/workspace";
    const firstScopeHash = resolveConfiguredScopeHash({
      workspaceDir,
      extraPaths: ["/tmp/workspace/media"],
      multimodal: {
        enabled: false,
        modalities: [],
        maxFileBytes: 20 * 1024 * 1024,
      },
    });
    const secondScopeHash = resolveConfiguredScopeHash({
      workspaceDir,
      extraPaths: ["/tmp/workspace/media"],
      multimodal: {
        enabled: true,
        modalities: ["image"],
        maxFileBytes: 20 * 1024 * 1024,
      },
    });

    expect(
      isMemoryIndexIdentityDirty(
        createIdentityParams({
          meta: createMeta({ scopeHash: firstScopeHash }),
          configuredScopeHash: secondScopeHash,
        }),
      ),
    ).toBe(true);
  });

  it("keeps older indexes with missing sources compatible with memory-only config", () => {
    expect(
      isMemoryIndexIdentityDirty(
        createIdentityParams({
          meta: createMeta({ sources: undefined }),
          configuredSources: resolveConfiguredSourcesForMeta(new Set(["memory"])),
        }),
      ),
    ).toBe(false);
  });

  it("falls back to fts-only when provider.model is an empty string", () => {
    expect(
      resolveMemoryIndexIdentityState(
        createIdentityParams({
          provider: { id: "openai", model: "" },
          meta: createMeta({ model: "fts-only" }),
        }),
      ),
    ).toEqual({ status: "valid" });
  });

  it("reports mismatch when empty-string expected model is compared to a non-fts index", () => {
    const state = resolveMemoryIndexIdentityState(
      createIdentityParams({
        provider: { id: "openai", model: "" },
        meta: createMeta({ model: "text-embedding-3-small" }),
      }),
    );
    expect(state.status).toBe("mismatched");
    if (state.status === "mismatched") {
      expect(state.reason).toContain("expected fts-only");
    }
  });

  it("falls back to fts-only when provider.model is whitespace-only", () => {
    expect(
      resolveMemoryIndexIdentityState(
        createIdentityParams({
          provider: { id: "openai", model: "  " },
          meta: createMeta({ model: "fts-only" }),
        }),
      ),
    ).toEqual({ status: "valid" });
  });
});
