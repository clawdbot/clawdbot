import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import {
  resolveConfiguredScopeHash,
  resolveConfiguredSourcesForMeta,
  shouldRunFullMemoryReindex,
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

function createFullReindexParams(
  overrides: {
    meta?: MemoryIndexMeta | null;
    provider?: { id: string; model: string } | null;
    providerKey?: string;
    configuredSources?: MemorySource[];
    configuredScopeHash?: string;
    chunkTokens?: number;
    chunkOverlap?: number;
    vectorReady?: boolean;
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
    ftsTokenizer: "unicode61",
    ...overrides,
  };
}

describe("memory reindex state", () => {
  it("requires a full reindex when the embedding model changes", () => {
    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          provider: { id: "openai", model: "mock-embed-v2" },
        }),
      ),
    ).toBe(true);
  });

  it("requires a full reindex when the provider cache key changes", () => {
    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
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

  it("requires a full reindex when extraPaths change", () => {
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
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          meta: createMeta({ scopeHash: firstScopeHash }),
          configuredScopeHash: secondScopeHash,
        }),
      ),
    ).toBe(true);
  });

  it("requires a full reindex when configured sources add sessions", () => {
    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          configuredSources: ["memory", "sessions"],
        }),
      ),
    ).toBe(true);
  });

  it("requires a full reindex when multimodal settings change", () => {
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
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          meta: createMeta({ scopeHash: firstScopeHash }),
          configuredScopeHash: secondScopeHash,
        }),
      ),
    ).toBe(true);
  });

  it("keeps older indexes with missing sources compatible with memory-only config", () => {
    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          meta: createMeta({ sources: undefined }),
          configuredSources: resolveConfiguredSourcesForMeta(new Set(["memory"])),
        }),
      ),
    ).toBe(false);
  });
});
