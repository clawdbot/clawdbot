import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";
// Manual facade. Keep loader boundary explicit.
import type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCreateOptions,
  MemoryEmbeddingProviderRuntime,
} from "./memory-core-host-engine-embeddings.js";

type EmbeddingProviderResult = {
  provider: MemoryEmbeddingProvider | null;
  requestedProvider: string;
  fallbackFrom?: string;
  fallbackReason?: string;
  providerUnavailableReason?: string;
  runtime?: MemoryEmbeddingProviderRuntime;
};

type RuntimeFacadeModule = {
  createEmbeddingProvider: (
    options: MemoryEmbeddingProviderCreateOptions & {
      provider: string;
      fallback: string;
    },
  ) => Promise<EmbeddingProviderResult>;
  registerBuiltInMemoryEmbeddingProviders: (register: {
    registerMemoryEmbeddingProvider: (adapter: MemoryEmbeddingProviderAdapter) => void;
  }) => void;
  removeGroundedShortTermCandidates: (params: {
    workspaceDir: string;
  }) => Promise<{ removed: number; storePath: string }>;
  repairDreamingArtifacts: (params: {
    workspaceDir: string;
    archiveDiary?: boolean;
    now?: Date;
  }) => Promise<RepairDreamingArtifactsResult>;
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

type RemDreamingPreview = {
  sourceEntryCount: number;
  reflections: string[];
  candidateTruths: Array<{
    snippet: string;
    confidence: number;
    evidence: string;
  }>;
  candidateKeys: string[];
  bodyLines: string[];
};

type PromotionCandidate = {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  recallCount: number;
  uniqueQueries: number;
  avgScore: number;
  maxScore: number;
  ageDays: number;
  firstRecalledAt: string;
  lastRecalledAt: string;
  promotedAt?: string;
};

type RemHarnessPreviewResult = {
  workspaceDir: string;
  nowMs: number;
  remConfig: {
    enabled: boolean;
    lookbackDays: number;
    limit: number;
    minPatternStrength: number;
  };
  deepConfig: {
    minScore: number;
    minRecallCount: number;
    minUniqueQueries: number;
    recencyHalfLifeDays: number;
    maxAgeDays?: number;
  };
  recallEntryCount: number;
  remSkipped: boolean;
  rem: RemDreamingPreview;
  groundedInputPaths: string[];
  grounded: GroundedRemPreviewResult | null;
  deep: {
    candidateLimit?: number;
    candidateCount: number;
    truncated: boolean;
    candidates: PromotionCandidate[];
  };
};

type ApiFacadeModule = {
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
  filterRecallEntriesWithinLookback: (params: {
    entries: readonly unknown[];
    nowMs: number;
    lookbackDays: number;
  }) => unknown[];
  previewRemHarness: (params: {
    workspaceDir: string;
    cfg?: unknown;
    pluginConfig?: Record<string, unknown>;
    grounded?: boolean;
    groundedInputPaths?: string[];
    groundedFileLimit?: number;
    includePromoted?: boolean;
    candidateLimit?: number;
    remPreviewLimit?: number;
    nowMs?: number;
  }) => Promise<RemHarnessPreviewResult>;
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

export const filterRecallEntriesWithinLookback: ApiFacadeModule["filterRecallEntriesWithinLookback"] =
  ((...args) =>
    loadApiFacadeModule().filterRecallEntriesWithinLookback(
      ...args,
    )) as ApiFacadeModule["filterRecallEntriesWithinLookback"];

export const previewRemHarness: ApiFacadeModule["previewRemHarness"] = ((...args) =>
  loadApiFacadeModule().previewRemHarness(...args)) as ApiFacadeModule["previewRemHarness"];
