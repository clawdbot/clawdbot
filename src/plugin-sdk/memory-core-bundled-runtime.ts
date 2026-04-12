// Manual facade. Keep loader boundary explicit.
type ApiFacadeModule = typeof import("@openclaw/memory-core/api.js");
type RuntimeFacadeModule = typeof import("@openclaw/memory-core/runtime-api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

function loadApiFacadeModule(): ApiFacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<ApiFacadeModule>({
    dirName: "memory-core",
    artifactBasename: "api.js",
  });
}

function loadRuntimeFacadeModule(): RuntimeFacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<RuntimeFacadeModule>({
    dirName: "memory-core",
    artifactBasename: "runtime-api.js",
  });
}

export const createEmbeddingProvider: RuntimeFacadeModule["createEmbeddingProvider"] = ((...args) =>
  loadRuntimeFacadeModule().createEmbeddingProvider(
    ...args,
  )) as RuntimeFacadeModule["createEmbeddingProvider"];

export const registerBuiltInMemoryEmbeddingProviders: RuntimeFacadeModule["registerBuiltInMemoryEmbeddingProviders"] =
  ((...args) =>
    loadRuntimeFacadeModule().registerBuiltInMemoryEmbeddingProviders(
      ...args,
    )) as RuntimeFacadeModule["registerBuiltInMemoryEmbeddingProviders"];

export const removeGroundedShortTermCandidates: RuntimeFacadeModule["removeGroundedShortTermCandidates"] =
  ((...args) =>
    loadRuntimeFacadeModule().removeGroundedShortTermCandidates(
      ...args,
    )) as RuntimeFacadeModule["removeGroundedShortTermCandidates"];
export const repairDreamingArtifacts: RuntimeFacadeModule["repairDreamingArtifacts"] = ((...args) =>
  loadRuntimeFacadeModule().repairDreamingArtifacts(
    ...args,
  )) as RuntimeFacadeModule["repairDreamingArtifacts"];

export const previewGroundedRemMarkdown: ApiFacadeModule["previewGroundedRemMarkdown"] = ((
  ...args
) =>
  loadApiFacadeModule().previewGroundedRemMarkdown(
    ...args,
  )) as ApiFacadeModule["previewGroundedRemMarkdown"];

export const dedupeDreamDiaryEntries: ApiFacadeModule["dedupeDreamDiaryEntries"] = ((...args) =>
  loadApiFacadeModule().dedupeDreamDiaryEntries(
    ...args,
  )) as ApiFacadeModule["dedupeDreamDiaryEntries"];

export const writeBackfillDiaryEntries: ApiFacadeModule["writeBackfillDiaryEntries"] = ((...args) =>
  loadApiFacadeModule().writeBackfillDiaryEntries(
    ...args,
  )) as ApiFacadeModule["writeBackfillDiaryEntries"];

export const removeBackfillDiaryEntries: ApiFacadeModule["removeBackfillDiaryEntries"] = ((
  ...args
) =>
  loadApiFacadeModule().removeBackfillDiaryEntries(
    ...args,
  )) as ApiFacadeModule["removeBackfillDiaryEntries"];
