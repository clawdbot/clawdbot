/**
 * @deprecated Public SDK subpath has no bundled extension production imports.
 * Prefer vendor-neutral memory-host SDK subpaths for new plugin code.
 */
import { createConfiguredProviderLocalServiceAcquirer } from "../agents/provider-local-service.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.js";
import { withPluginStateLease } from "../plugin-state/plugin-state-lease.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { loadActivatedBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";
import type { MemorySearchManager } from "./memory-core-host-engine-storage.js";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
  PluginStateLeaseRunner,
} from "./plugin-state-runtime.js";

/** Doctor metadata for a built-in memory embedding provider. */
export type BuiltinMemoryEmbeddingProviderDoctorMetadata = {
  providerId: string;
  authProviderId: string;
  envVars: string[];
  transport: "local" | "remote";
  autoSelectPriority?: number;
};

/** One issue found while auditing dreaming/session-corpus artifacts. */
export type DreamingArtifactsAuditIssue = {
  severity: "warn" | "error";
  code:
    | "dreaming-session-corpus-unreadable"
    | "dreaming-session-corpus-self-ingested"
    | "dreaming-session-ingestion-unreadable"
    | "dreaming-diary-unreadable";
  message: string;
  fixable: boolean;
};

/** Summary of dreaming diary and session-corpus artifact health. */
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

/** Result from archiving or repairing problematic dreaming artifacts. */
export type RepairDreamingArtifactsResult = {
  changed: boolean;
  archiveDir?: string;
  archivedDreamsDiary: boolean;
  archivedSessionCorpus: boolean;
  archivedSessionIngestion: boolean;
  archivedPaths: string[];
  warnings: string[];
};

/** One issue found while auditing short-term promotion artifacts. */
export type ShortTermAuditIssue = {
  severity: "warn" | "error";
  code:
    | "recall-store-unreadable"
    | "recall-store-empty"
    | "recall-store-invalid"
    | "recall-store-over-limit"
    | "recall-lock-stale"
    | "recall-lock-unreadable"
    | "qmd-index-missing"
    | "qmd-index-empty"
    | "qmd-collections-empty";
  message: string;
  fixable: boolean;
};

/** Summary of recall-store and qmd state used by short-term promotion. */
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
  issues: ShortTermAuditIssue[];
  qmd?:
    | {
        dbPath?: string;
        collections?: number;
        dbBytes?: number;
      }
    | undefined;
};

/** Result from repairing invalid recall-store entries or stale short-term locks. */
export type RepairShortTermPromotionArtifactsResult = {
  changed: boolean;
  removedInvalidEntries: number;
  removedOverflowEntries?: number;
  rewroteStore: boolean;
  removedStaleLock: boolean;
};

type MemoryIndexManagerFacade = {
  get(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status";
  }): Promise<MemorySearchManager | null>;
};

type FacadeModule = {
  configureMemoryCoreDreamingState: (
    openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
  ) => void;
  auditShortTermPromotionArtifacts: (params: {
    workspaceDir: string;
    qmd?: {
      dbPath?: string;
      collections?: number;
    };
  }) => Promise<ShortTermAuditSummary>;
  auditDreamingArtifacts: (params: {
    workspaceDir: string;
  }) => Promise<DreamingArtifactsAuditSummary>;
  getBuiltinMemoryEmbeddingProviderDoctorMetadata: (
    providerId: string,
  ) => BuiltinMemoryEmbeddingProviderDoctorMetadata | null;
  getMemorySearchManager: (params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status" | "cli";
  }) => Promise<{
    manager: MemorySearchManager | null;
    error?: string;
  }>;
  listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata: () => Array<BuiltinMemoryEmbeddingProviderDoctorMetadata>;
  MemoryIndexManager: MemoryIndexManagerFacade;
  repairShortTermPromotionArtifacts: (params: {
    workspaceDir: string;
  }) => Promise<RepairShortTermPromotionArtifactsResult>;
  repairDreamingArtifacts: (params: {
    workspaceDir: string;
    archiveDiary?: boolean;
    now?: Date;
  }) => Promise<RepairDreamingArtifactsResult>;
};

function loadFacadeModule(): FacadeModule {
  const module = loadActivatedBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "memory-core",
    artifactBasename: "runtime-api.js",
  });
  module.configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStore<T>("memory-core", options),
  );
  return module;
}

const acquireLocalService = createConfiguredProviderLocalServiceAcquirer(getRuntimeConfig);
const withLease: PluginStateLeaseRunner = (options, run) =>
  withPluginStateLease("memory-core", options, run);
/** Audit short-term promotion artifacts in an agent workspace. */
export const auditShortTermPromotionArtifacts: FacadeModule["auditShortTermPromotionArtifacts"] = ((
  ...args
) =>
  loadFacadeModule()["auditShortTermPromotionArtifacts"](
    ...args,
  )) as FacadeModule["auditShortTermPromotionArtifacts"];
/** Audit dreaming diary and session-corpus artifacts in an agent workspace. */
export const auditDreamingArtifacts: FacadeModule["auditDreamingArtifacts"] = ((...args) =>
  loadFacadeModule()["auditDreamingArtifacts"](...args)) as FacadeModule["auditDreamingArtifacts"];
/** Resolve doctor metadata for one built-in memory embedding provider. */
export const getBuiltinMemoryEmbeddingProviderDoctorMetadata: FacadeModule["getBuiltinMemoryEmbeddingProviderDoctorMetadata"] =
  ((...args) =>
    loadFacadeModule()["getBuiltinMemoryEmbeddingProviderDoctorMetadata"](
      ...args,
    )) as FacadeModule["getBuiltinMemoryEmbeddingProviderDoctorMetadata"];
/** Resolve the active memory search manager and any runtime availability error. */
export const getMemorySearchManager: FacadeModule["getMemorySearchManager"] = ((params) => {
  const managerParams = {
    ...params,
    acquireLocalService,
    withLease,
  };
  return loadFacadeModule()["getMemorySearchManager"](managerParams);
}) as FacadeModule["getMemorySearchManager"];
/** List built-in memory embedding providers eligible for automatic selection. */
export const listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata: FacadeModule["listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata"] =
  ((...args) =>
    loadFacadeModule()["listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata"](
      ...args,
    )) as FacadeModule["listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata"];
/** Lazy memory index manager facade used by status and runtime callers. */
export const MemoryIndexManager: FacadeModule["MemoryIndexManager"] = {
  async get(params) {
    const managerParams = {
      ...params,
      acquireLocalService,
      withLease,
    };
    return await loadFacadeModule()["MemoryIndexManager"].get(managerParams);
  },
};
/** Repair invalid recall-store entries and stale short-term promotion locks. */
export const repairShortTermPromotionArtifacts: FacadeModule["repairShortTermPromotionArtifacts"] =
  ((...args) =>
    loadFacadeModule()["repairShortTermPromotionArtifacts"](
      ...args,
    )) as FacadeModule["repairShortTermPromotionArtifacts"];
/** Repair or archive problematic dreaming artifacts. */
export const repairDreamingArtifacts: FacadeModule["repairDreamingArtifacts"] = ((...args) =>
  loadFacadeModule()["repairDreamingArtifacts"](
    ...args,
  )) as FacadeModule["repairDreamingArtifacts"];
