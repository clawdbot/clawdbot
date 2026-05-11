/**
 * @deprecated Public SDK subpath has no bundled extension production imports.
 * Prefer vendor-neutral memory-host SDK subpaths for new plugin code.
 */
import type { OpenClawConfig } from "../config/types.js";
import {
  createLazyFacadeObjectValue,
  loadActivatedBundledPluginPublicSurfaceModuleSync,
} from "./facade-runtime.js";
import type { MemorySearchManager } from "./memory-core-host-engine-storage.js";

export type BuiltinMemoryEmbeddingProviderDoctorMetadata = {
  providerId: string;
  authProviderId: string;
  envVars: string[];
  transport: "local" | "remote";
  autoSelectPriority?: number;
};

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

export type RepairDreamingArtifactsResult = {
  changed: boolean;
  archiveDir?: string;
  archivedDreamsDiary: boolean;
  archivedSessionCorpus: boolean;
  archivedSessionIngestion: boolean;
  archivedPaths: string[];
  warnings: string[];
};

export type ShortTermAuditIssue = {
  severity: "warn" | "error";
  code:
    | "recall-store-unreadable"
    | "recall-store-empty"
    | "recall-store-invalid"
    | "recall-lock-stale"
    | "recall-lock-unreadable"
    | "qmd-index-missing"
    | "qmd-index-empty"
    | "qmd-collections-empty";
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
  issues: ShortTermAuditIssue[];
  qmd?:
    | {
        dbPath?: string;
        collections?: number;
        dbBytes?: number;
      }
    | undefined;
};

export type RepairShortTermPromotionArtifactsResult = {
  changed: boolean;
  removedInvalidEntries: number;
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
    purpose?: "default" | "status";
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
