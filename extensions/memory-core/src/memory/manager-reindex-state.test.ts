// Memory Core tests cover manager reindex state plugin behavior.
import {
  MEMORY_CHUNKING_VERSION,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import {
  MEMORY_INDEX_PROVENANCE_VERSION,
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
    chunkingVersion: MEMORY_CHUNKING_VERSION,
    ftsTokenizer: "unicode61",
    provenanceVersion: MEMORY_INDEX_PROVENANCE_VERSION,
    ...overrides,
  };
}

function createIdentityParams(
  overrides: {
    meta?: MemoryIndexMeta | null;
    provider?: { id: string; model?: string } | null;
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
  it.each([
    {
      name: "missing provenance version",
      meta: { provenanceVersion: undefined },
      reason: "index provenance classifier changed",
      code: "provenance_version",
    },
    {
      name: "missing chunking version",
      meta: { chunkingVersion: undefined },
      reason: "index chunking implementation changed",
      code: "chunking_version",
    },
  ])("invalidates indexes with $name as OpenClaw-owned", ({ meta, reason, code }) => {
    expect(
      resolveMemoryIndexIdentityState(createIdentityParams({ meta: createMeta(meta) })),
    ).toEqual({
      status: "mismatched",
      reason,
      code,
      owner: "openclaw",
    });
  });

  it("classifies missing metadata as OpenClaw-owned", () => {
    expect(resolveMemoryIndexIdentityState(createIdentityParams({ meta: null }))).toEqual({
      status: "missing",
      reason: "index metadata is missing",
      code: "metadata_missing",
      owner: "openclaw",
    });
  });

  it.each([
    { name: "chunk settings", params: { chunkTokens: 3999 }, code: "chunking" },
    { name: "FTS tokenizer", params: { ftsTokenizer: "porter" }, code: "fts_tokenizer" },
  ])("classifies changed $name as configuration-owned", ({ params, code }) => {
    expect(resolveMemoryIndexIdentityState(createIdentityParams(params))).toMatchObject({
      status: "mismatched",
      code,
      owner: "configuration",
    });
  });

  it("retains the primary provider identity when its model is empty", () => {
    expect(
      resolveMemoryIndexProviderIdentities({
        provider: { id: "empty-model-provider", model: "" },
      }),
    ).toMatchObject([{ provider: "empty-model-provider", model: "" }]);
  });

  it("marks identity dirty when the embedding model changes", () => {
    expect(
      resolveMemoryIndexIdentityState(
        createIdentityParams({ provider: { id: "openai", model: "mock-embed-v2" } }),
      ),
    ).toMatchObject({ status: "mismatched", code: "model", owner: "configuration" });
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
      code: "provider",
      owner: "configuration",
    });
  });

  it("marks identity dirty when the provider cache key changes", () => {
    expect(
      resolveMemoryIndexIdentityState(
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
    ).toMatchObject({
      status: "mismatched",
      code: "provider_settings",
      owner: "configuration",
    });
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

  it("defers only model and key checks when the configured model is unknown", () => {
    const params = createIdentityParams({ provider: { id: "openai" }, providerKey: undefined });
    expect(resolveMemoryIndexIdentityState(params)).toEqual({ status: "valid" });
    expect(resolveMemoryIndexIdentityState({ ...params, provider: { id: "other" } })).toEqual({
      status: "mismatched",
      reason: "index was built for provider openai, expected other",
      code: "provider",
      owner: "configuration",
    });
    expect(resolveMemoryIndexIdentityState({ ...params, configuredScopeHash: "other" })).toEqual({
      status: "mismatched",
      reason: "index scope changed",
      code: "scope",
      owner: "configuration",
    });
    expect(resolveMemoryIndexIdentityState({ ...params, vectorReady: true })).toEqual({
      status: "mismatched",
      reason: "index vector dimensions are missing",
      code: "vector_dims",
      owner: "configuration",
    });
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
      code: "model",
      owner: "configuration",
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
      code: "provider_settings",
      owner: "configuration",
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
      resolveMemoryIndexIdentityState(
        createIdentityParams({
          meta: createMeta({ scopeHash: firstScopeHash }),
          configuredScopeHash: secondScopeHash,
        }),
      ),
    ).toMatchObject({ status: "mismatched", code: "scope", owner: "configuration" });
  });

  it("includes extra path patterns in stable scope identity", () => {
    const workspaceDir = "/tmp/workspace";
    const multimodal = {
      enabled: false,
      modalities: [],
      maxFileBytes: 20 * 1024 * 1024,
    };
    const firstScopeHash = resolveConfiguredScopeHash({
      workspaceDir,
      extraPaths: [
        { path: "notes", pattern: "runbooks/**/*.md" },
        { path: "notes", pattern: "decisions/**/*.md" },
      ],
      multimodal,
    });
    const reorderedScopeHash = resolveConfiguredScopeHash({
      workspaceDir,
      extraPaths: [
        { path: "notes", pattern: "decisions/**/*.md" },
        { path: "notes", pattern: "runbooks/**/*.md" },
      ],
      multimodal,
    });
    const changedScopeHash = resolveConfiguredScopeHash({
      workspaceDir,
      extraPaths: [{ path: "notes", pattern: "archive/**/*.md" }],
      multimodal,
    });

    expect(reorderedScopeHash).toBe(firstScopeHash);
    expect(changedScopeHash).not.toBe(firstScopeHash);
    expect(resolveConfiguredScopeHash({ workspaceDir, extraPaths: ["notes"], multimodal })).toBe(
      resolveConfiguredScopeHash({
        workspaceDir,
        extraPaths: [{ path: "notes" }],
        multimodal,
      }),
    );
    expect(
      isMemoryIndexIdentityDirty(
        createIdentityParams({
          meta: createMeta({ scopeHash: firstScopeHash }),
          configuredScopeHash: changedScopeHash,
        }),
      ),
    ).toBe(true);
  });

  it("marks identity dirty when configured sources add sessions", () => {
    expect(
      resolveMemoryIndexIdentityState(
        createIdentityParams({
          configuredSources: ["memory", "sessions"],
        }),
      ),
    ).toMatchObject({ status: "mismatched", code: "sources", owner: "configuration" });
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
      resolveMemoryIndexIdentityState(
        createIdentityParams({
          meta: createMeta({ scopeHash: firstScopeHash }),
          configuredScopeHash: secondScopeHash,
        }),
      ),
    ).toMatchObject({ status: "mismatched", code: "scope", owner: "configuration" });
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

  it.each([
    { name: "empty model", model: "" },
    { name: "whitespace-only model", model: "  " },
  ])("falls back to fts-only for $name", ({ model }) => {
    expect(
      resolveMemoryIndexIdentityState(
        createIdentityParams({
          provider: { id: "openai", model },
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
});
