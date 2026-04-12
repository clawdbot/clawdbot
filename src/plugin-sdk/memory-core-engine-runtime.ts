// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/memory-core/runtime-api.js");
import {
  createLazyFacadeObjectValue,
  loadActivatedBundledPluginPublicSurfaceModuleSync,
} from "./facade-runtime.js";

function loadFacadeModule(): FacadeModule {
  return loadActivatedBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "memory-core",
    artifactBasename: "runtime-api.js",
  });
}
export const auditShortTermPromotionArtifacts: FacadeModule["auditShortTermPromotionArtifacts"] = ((
  ...args
) =>
  loadFacadeModule()["auditShortTermPromotionArtifacts"](
    ...args,
  )) as FacadeModule["auditShortTermPromotionArtifacts"];
export const auditDreamingArtifacts: FacadeModule["auditDreamingArtifacts"] = ((...args) =>
  loadFacadeModule()["auditDreamingArtifacts"](...args)) as FacadeModule["auditDreamingArtifacts"];
export const getBuiltinMemoryEmbeddingProviderDoctorMetadata: FacadeModule["getBuiltinMemoryEmbeddingProviderDoctorMetadata"] =
  ((...args) =>
    loadFacadeModule()["getBuiltinMemoryEmbeddingProviderDoctorMetadata"](
      ...args,
    )) as FacadeModule["getBuiltinMemoryEmbeddingProviderDoctorMetadata"];
export const getMemorySearchManager: FacadeModule["getMemorySearchManager"] = ((...args) =>
  loadFacadeModule()["getMemorySearchManager"](...args)) as FacadeModule["getMemorySearchManager"];
export const listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata: FacadeModule["listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata"] =
  ((...args) =>
    loadFacadeModule()["listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata"](
      ...args,
    )) as FacadeModule["listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata"];
export const MemoryIndexManager: FacadeModule["MemoryIndexManager"] = createLazyFacadeObjectValue(
  () => loadFacadeModule()["MemoryIndexManager"] as object,
) as FacadeModule["MemoryIndexManager"];
export const repairShortTermPromotionArtifacts: FacadeModule["repairShortTermPromotionArtifacts"] =
  ((...args) =>
    loadFacadeModule()["repairShortTermPromotionArtifacts"](
      ...args,
    )) as FacadeModule["repairShortTermPromotionArtifacts"];
export const repairDreamingArtifacts: FacadeModule["repairDreamingArtifacts"] = ((...args) =>
  loadFacadeModule()["repairDreamingArtifacts"](
    ...args,
  )) as FacadeModule["repairDreamingArtifacts"];
export type BuiltinMemoryEmbeddingProviderDoctorMetadata =
  import("@openclaw/memory-core/runtime-api.js").BuiltinMemoryEmbeddingProviderDoctorMetadata;
export type DreamingArtifactsAuditSummary =
  import("@openclaw/memory-core/runtime-api.js").DreamingArtifactsAuditSummary;
export type RepairDreamingArtifactsResult =
  import("@openclaw/memory-core/runtime-api.js").RepairDreamingArtifactsResult;
export type RepairShortTermPromotionArtifactsResult =
  import("@openclaw/memory-core/runtime-api.js").RepairShortTermPromotionArtifactsResult;
export type ShortTermAuditSummary =
  import("@openclaw/memory-core/runtime-api.js").ShortTermAuditSummary;
