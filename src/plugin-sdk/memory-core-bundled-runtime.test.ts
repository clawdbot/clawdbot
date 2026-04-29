import { beforeEach, describe, expect, it, vi } from "vitest";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const createEmbeddingProviderImpl = vi.hoisted(() => vi.fn());
const registerBuiltInMemoryEmbeddingProvidersImpl = vi.hoisted(() => vi.fn());
const removeGroundedShortTermCandidatesImpl = vi.hoisted(() => vi.fn());
const previewGroundedRemMarkdownImpl = vi.hoisted(() => vi.fn());
const writeBackfillDiaryEntriesImpl = vi.hoisted(() => vi.fn());
const removeBackfillDiaryEntriesImpl = vi.hoisted(() => vi.fn());
const filterRecallEntriesWithinLookbackImpl = vi.hoisted(() => vi.fn());
const previewRemHarnessImpl = vi.hoisted(() => vi.fn());

vi.mock("./facade-loader.js", async () => {
  const actual = await vi.importActual<typeof import("./facade-loader.js")>("./facade-loader.js");
  return {
    ...actual,
    loadBundledPluginPublicSurfaceModuleSync,
  };
});

describe("plugin-sdk memory-core bundled runtime", () => {
  beforeEach(() => {
    createEmbeddingProviderImpl.mockReset().mockResolvedValue({ provider: { id: "openai" } });
    registerBuiltInMemoryEmbeddingProvidersImpl.mockReset();
    removeGroundedShortTermCandidatesImpl.mockReset().mockResolvedValue({ removed: 1 });
    previewGroundedRemMarkdownImpl.mockReset().mockResolvedValue({ files: [] });
    writeBackfillDiaryEntriesImpl.mockReset().mockResolvedValue({ writtenCount: 1 });
    removeBackfillDiaryEntriesImpl.mockReset().mockResolvedValue({ removedCount: 1 });
    filterRecallEntriesWithinLookbackImpl.mockReset().mockReturnValue([]);
    previewRemHarnessImpl.mockReset().mockResolvedValue({ ok: true });
    loadBundledPluginPublicSurfaceModuleSync
      .mockReset()
      .mockImplementation(({ artifactBasename }) => {
        if (artifactBasename === "runtime-api.js") {
          return {
            createEmbeddingProvider: createEmbeddingProviderImpl,
            registerBuiltInMemoryEmbeddingProviders: registerBuiltInMemoryEmbeddingProvidersImpl,
            removeGroundedShortTermCandidates: removeGroundedShortTermCandidatesImpl,
          };
        }
        if (artifactBasename === "api.js") {
          return {
            previewGroundedRemMarkdown: previewGroundedRemMarkdownImpl,
            writeBackfillDiaryEntries: writeBackfillDiaryEntriesImpl,
            removeBackfillDiaryEntries: removeBackfillDiaryEntriesImpl,
            filterRecallEntriesWithinLookback: filterRecallEntriesWithinLookbackImpl,
            previewRemHarness: previewRemHarnessImpl,
          };
        }
        throw new Error(`unexpected artifact ${String(artifactBasename)}`);
      });
  });

  it("keeps the bundled memory facade cold until a helper is used", async () => {
    const module = await import("./memory-core-bundled-runtime.js");

    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
    await module.createEmbeddingProvider({} as never);
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "memory-core",
      artifactBasename: "runtime-api.js",
    });
  });

  it("delegates doctor and embedding helpers through the bundled public surfaces", async () => {
    const module = await import("./memory-core-bundled-runtime.js");

    await module.previewGroundedRemMarkdown({} as never);
    await module.removeGroundedShortTermCandidates({} as never);
    module.registerBuiltInMemoryEmbeddingProviders({} as never);

    expect(previewGroundedRemMarkdownImpl).toHaveBeenCalledWith({} as never);
    expect(removeGroundedShortTermCandidatesImpl).toHaveBeenCalledWith({} as never);
    expect(registerBuiltInMemoryEmbeddingProvidersImpl).toHaveBeenCalledWith({} as never);
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "memory-core",
      artifactBasename: "api.js",
    });
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "memory-core",
      artifactBasename: "runtime-api.js",
    });
  });

  it("delegates filterRecallEntriesWithinLookback through the bundled api surface", async () => {
    const module = await import("./memory-core-bundled-runtime.js");
    const kept = [{ key: "keep" }] as never;
    filterRecallEntriesWithinLookbackImpl.mockReturnValueOnce(kept);

    const params = { entries: [] as never, nowMs: 0, lookbackDays: 1 };
    const result = module.filterRecallEntriesWithinLookback(params);

    expect(result).toBe(kept);
    expect(filterRecallEntriesWithinLookbackImpl).toHaveBeenCalledWith(params);
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "memory-core",
      artifactBasename: "api.js",
    });
  });

  it("delegates previewRemHarness through the bundled api surface", async () => {
    const module = await import("./memory-core-bundled-runtime.js");
    const preview = { workspaceDir: "/tmp/openclaw" };
    previewRemHarnessImpl.mockResolvedValueOnce(preview);

    const params = { workspaceDir: "/tmp/openclaw", candidateLimit: 3 };
    const result = await module.previewRemHarness(params);

    expect(result).toBe(preview);
    expect(previewRemHarnessImpl).toHaveBeenCalledWith(params);
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "memory-core",
      artifactBasename: "api.js",
    });
  });
});
