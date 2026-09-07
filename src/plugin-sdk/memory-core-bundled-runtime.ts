// Manual facade. Keep loader boundary explicit.
import { createConfiguredProviderLocalServiceAcquirer } from "../agents/provider-local-service.js";
import { getRuntimeConfig } from "../config/config.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
// Memory core bundled runtime helpers load the internal memory plugin through SDK facades.
import { loadBundledPluginPublicSurfaceModuleSyncCore } from "./facade-loader.js";
import type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderCreateOptions,
  MemoryEmbeddingProviderRuntime,
} from "./memory-core-host-engine-embeddings.js";
import type { OpenKeyedStoreOptions, PluginStateKeyedStore } from "./plugin-state-runtime.js";

type EmbeddingProviderResult = {
  provider: MemoryEmbeddingProvider | null;
  requestedProvider: string;
  fallbackFrom?: string;
  fallbackReason?: string;
  providerUnavailableReason?: string;
  runtime?: MemoryEmbeddingProviderRuntime;
};

type DreamingArtifactsAuditIssue = {
  severity: "warn" | "error";
  code:
    | "dreaming-session-corpus-unreadable"
    | "dreaming-session-corpus-self-ingested"
    | "dreaming-session-ingestion-unreadable"
    | "dreaming-diary-unreadable";
  message: string;
  fixable: boolean;
};

export type DreamingArtifactsAuditSummary = {
  dreamsPath?: string;
  sessionCorpusDir: string;
  sessionCorpusFileCount: number;
  suspiciousSessionCorpusFileCount: number;
  suspiciousSessionCorpusLineCount: number;
  sessionIngestionPath: string;
  sessionIngestionExists: boolean;
  issues: DreamingArtifactsAuditIssue[];
};

type ShortTermAuditIssue = {
  severity: "warn" | "error";
  code:
    | "recall-store-unreadable"
    | "recall-store-empty"
    | "recall-store-invalid"
    | "recall-store-dangling"
    | "recall-store-over-limit"
    | "recall-lock-stale"
    | "recall-lock-unreadable";
  message: string;
  fixable: boolean;
};

export type ShortTermAuditSummary = {
  storePath: string;
  lockPath: string;
  updatedAt?: string;
  exists: boolean;
  entryCount: number;
  promotedCount: number;
  spacedEntryCount: number;
  conceptTaggedEntryCount: number;
  conceptTagScripts?: Record<string, unknown>;
  invalidEntryCount: number;
  danglingEntryCount?: number;
  issues: ShortTermAuditIssue[];
};

type RepairShortTermPromotionArtifactsResult = {
  changed: boolean;
  removedInvalidEntries: number;
  removedDanglingEntries?: number;
  removedOverflowEntries?: number;
  rewroteStore: boolean;
  removedStaleLock: boolean;
};

type RuntimeFacadeModule = {
  configureMemoryCoreDreamingState: (
    openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
  ) => void;
  createEmbeddingProvider: (
    options: Omit<MemoryEmbeddingProviderCreateOptions, "dimensions"> & {
      provider: string;
      fallback: string;
      outputDimensionality?: number;
    },
  ) => Promise<EmbeddingProviderResult>;
  removeGroundedShortTermCandidates: (params: {
    workspaceDir: string;
  }) => Promise<{ removed: number; storePath: string }>;
  loadShortTermPromotionDreamingStats: (params: {
    workspaceDir: string;
    nowMs: number;
    timezone?: string;
  }) => Promise<ShortTermDreamingStats>;
  auditDreamingArtifacts: (params: {
    workspaceDir: string;
  }) => Promise<DreamingArtifactsAuditSummary>;
  auditShortTermPromotionArtifacts: (params: {
    workspaceDir: string;
  }) => Promise<ShortTermAuditSummary>;
  repairDreamingArtifacts: (params: {
    workspaceDir: string;
    archiveDiary?: boolean;
    now?: Date;
  }) => Promise<RepairDreamingArtifactsResult>;
  repairShortTermPromotionArtifacts: (params: {
    workspaceDir: string;
  }) => Promise<RepairShortTermPromotionArtifactsResult>;
};

type GroundedRemPreviewItem = {
  text: string;
  refs: string[];
};

type GroundedRemCandidate = GroundedRemPreviewItem & {
  lean: "likely_durable" | "unclear" | "likely_situational";
};

type GroundedRemFilePreview = {
  path: string;
  facts: GroundedRemPreviewItem[];
  reflections: GroundedRemPreviewItem[];
  memoryImplications: GroundedRemPreviewItem[];
  candidates: GroundedRemCandidate[];
  renderedMarkdown: string;
};

type GroundedRemPreviewResult = {
  workspaceDir: string;
  scannedFiles: number;
  files: GroundedRemFilePreview[];
};

type ShortTermDreamingStatsEntry = {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  recallCount: number;
  dailyCount: number;
  groundedCount: number;
  totalSignalCount: number;
  lightHits: number;
  remHits: number;
  phaseHitCount: number;
  promotedAt?: string;
  lastRecalledAt?: string;
};

type ShortTermDreamingStats = {
  shortTermCount: number;
  recallSignalCount: number;
  dailySignalCount: number;
  groundedSignalCount: number;
  totalSignalCount: number;
  phaseSignalCount: number;
  lightPhaseHitCount: number;
  remPhaseHitCount: number;
  promotedTotal: number;
  promotedToday: number;
  storePath: string;
  phaseSignalPath: string;
  phaseSignalError?: string;
  lastPromotedAt?: string;
  shortTermEntries: ShortTermDreamingStatsEntry[];
  signalEntries: ShortTermDreamingStatsEntry[];
  promotedEntries: ShortTermDreamingStatsEntry[];
};

type ApiFacadeModule = {
  MISSING_LOCAL_MEMORY_EMBEDDING_PROVIDER_MESSAGE: string;
  configureMemoryCoreDreamingState: (
    openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
  ) => void;
  previewGroundedRemMarkdown: (params: {
    workspaceDir: string;
    inputPaths: string[];
  }) => Promise<GroundedRemPreviewResult>;
  dedupeDreamDiaryEntries: (params: {
    workspaceDir: string;
  }) => Promise<{ dreamsPath: string; removed: number; kept: number }>;
  writeBackfillDiaryEntries: (params: {
    workspaceDir: string;
    entries: Array<{
      isoDay: string;
      bodyLines: string[];
      sourcePath?: string;
    }>;
    timezone?: string;
  }) => Promise<{ dreamsPath: string; written: number; replaced: number }>;
  removeBackfillDiaryEntries: (params: {
    workspaceDir: string;
  }) => Promise<{ dreamsPath: string; removed: number }>;
};

type RepairDreamingArtifactsResult = {
  changed: boolean;
  archiveDir?: string;
  archivedDreamsDiary: boolean;
  archivedSessionCorpus: boolean;
  archivedSessionIngestion: boolean;
  archivedPaths: string[];
  warnings: string[];
};

function loadApiFacadeModule(): ApiFacadeModule {
  const module = loadBundledPluginPublicSurfaceModuleSyncCore<ApiFacadeModule>({
    dirName: "memory-core",
    artifactBasename: "api.js",
  });
  module.configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStore<T>("memory-core", options),
  );
  return module;
}

function loadRuntimeFacadeModule(): RuntimeFacadeModule {
  const module = loadBundledPluginPublicSurfaceModuleSyncCore<RuntimeFacadeModule>({
    dirName: "memory-core",
    artifactBasename: "runtime-api.js",
  });
  module.configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStore<T>("memory-core", options),
  );
  return module;
}

/** Returns the memory-core-owned recovery message for an absent local provider plugin. */
export function getMissingLocalMemoryEmbeddingProviderMessage(): string {
  return loadApiFacadeModule().MISSING_LOCAL_MEMORY_EMBEDDING_PROVIDER_MESSAGE;
}

const acquireLocalService = createConfiguredProviderLocalServiceAcquirer(getRuntimeConfig);

/** Create a memory embedding provider with built-in fallback metadata. */
export const createEmbeddingProvider: RuntimeFacadeModule["createEmbeddingProvider"] = ((
  options,
) => {
  const createOptions = {
    ...options,
    acquireLocalService,
  };
  return loadRuntimeFacadeModule().createEmbeddingProvider(createOptions);
}) as RuntimeFacadeModule["createEmbeddingProvider"];

/** Remove short-term recall candidates already grounded into durable memory. */
export const removeGroundedShortTermCandidates: RuntimeFacadeModule["removeGroundedShortTermCandidates"] =
  ((...args) =>
    loadRuntimeFacadeModule().removeGroundedShortTermCandidates(
      ...args,
    )) as RuntimeFacadeModule["removeGroundedShortTermCandidates"];
/** Load short-term dreaming stats for doctor/control status. */
export const loadShortTermPromotionDreamingStats: RuntimeFacadeModule["loadShortTermPromotionDreamingStats"] =
  ((...args) =>
    loadRuntimeFacadeModule().loadShortTermPromotionDreamingStats(
      ...args,
    )) as RuntimeFacadeModule["loadShortTermPromotionDreamingStats"];
/** Audit dreaming diary and session-corpus artifacts through the bundled runtime facade. */
export const auditDreamingArtifacts: RuntimeFacadeModule["auditDreamingArtifacts"] = ((...args) =>
  loadRuntimeFacadeModule().auditDreamingArtifacts(
    ...args,
  )) as RuntimeFacadeModule["auditDreamingArtifacts"];
/** Audit short-term promotion artifacts through the bundled runtime facade. */
export const auditShortTermPromotionArtifacts: RuntimeFacadeModule["auditShortTermPromotionArtifacts"] =
  ((...args) =>
    loadRuntimeFacadeModule().auditShortTermPromotionArtifacts(
      ...args,
    )) as RuntimeFacadeModule["auditShortTermPromotionArtifacts"];
/** Repair or archive problematic dreaming artifacts through the bundled runtime facade. */
export const repairDreamingArtifacts: RuntimeFacadeModule["repairDreamingArtifacts"] = ((...args) =>
  loadRuntimeFacadeModule().repairDreamingArtifacts(
    ...args,
  )) as RuntimeFacadeModule["repairDreamingArtifacts"];
/** Repair short-term promotion artifacts through the bundled runtime facade. */
export const repairShortTermPromotionArtifacts: RuntimeFacadeModule["repairShortTermPromotionArtifacts"] =
  ((...args) =>
    loadRuntimeFacadeModule().repairShortTermPromotionArtifacts(
      ...args,
    )) as RuntimeFacadeModule["repairShortTermPromotionArtifacts"];

/** Preview grounded REM markdown facts and candidates for selected input files. */
export const previewGroundedRemMarkdown: ApiFacadeModule["previewGroundedRemMarkdown"] = ((
  ...args
) =>
  loadApiFacadeModule().previewGroundedRemMarkdown(
    ...args,
  )) as ApiFacadeModule["previewGroundedRemMarkdown"];

/** Remove duplicate dreaming diary entries while preserving canonical records. */
export const dedupeDreamDiaryEntries: ApiFacadeModule["dedupeDreamDiaryEntries"] = ((...args) =>
  loadApiFacadeModule().dedupeDreamDiaryEntries(
    ...args,
  )) as ApiFacadeModule["dedupeDreamDiaryEntries"];

/** Write synthetic/backfill dreaming diary entries for harness or migration use. */
export const writeBackfillDiaryEntries: ApiFacadeModule["writeBackfillDiaryEntries"] = ((...args) =>
  loadApiFacadeModule().writeBackfillDiaryEntries(
    ...args,
  )) as ApiFacadeModule["writeBackfillDiaryEntries"];

/** Remove dreaming diary entries previously written by the backfill helper. */
export const removeBackfillDiaryEntries: ApiFacadeModule["removeBackfillDiaryEntries"] = ((
  ...args
) =>
  loadApiFacadeModule().removeBackfillDiaryEntries(
    ...args,
  )) as ApiFacadeModule["removeBackfillDiaryEntries"];
