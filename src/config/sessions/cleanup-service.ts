import fs from "node:fs";
import path from "node:path";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveStoredSessionOwnerAgentId } from "../../gateway/session-store-key.js";
import { getLogger } from "../../logging/logger.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  enforceSessionDiskBudget,
  pruneUnreferencedSessionArtifacts,
  resolveSessionArtifactCanonicalPathsForEntry,
  type SessionUnreferencedArtifactSweepResult,
} from "./disk-budget.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveStorePath,
} from "./paths.js";
import { cloneSessionStoreRecord } from "./store-cache.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  pruneStaleEntries,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import {
  loadSessionStore,
  updateSessionStore,
  type SessionMaintenanceApplyReport,
} from "./store.js";
import {
  resolveSessionStoreTargets,
  type SessionStoreTarget,
  type SessionStoreSelectionOptions,
} from "./targets.js";
import type { SessionEntry } from "./types.js";

export type SessionsCleanupOptions = SessionStoreSelectionOptions & {
  dryRun?: boolean;
  enforce?: boolean;
  activeKey?: string;
  json?: boolean;
  fixMissing?: boolean;
};

export type SessionCleanupAction =
  | "keep"
  | "prune-missing"
  | "prune-stale"
  | "cap-overflow"
  | "evict-budget";

export type SessionCleanupSummary = {
  agentId: string;
  storePath: string;
  mode: ResolvedSessionMaintenanceConfig["mode"];
  dryRun: boolean;
  beforeCount: number;
  afterCount: number;
  missing: number;
  pruned: number;
  capped: number;
  unreferencedArtifacts: SessionUnreferencedArtifactSweepResult;
  diskBudget: Awaited<ReturnType<typeof enforceSessionDiskBudget>>;
  wouldMutate: boolean;
  applied?: true;
  appliedCount?: number;
};

export type SessionsCleanupResult =
  | SessionCleanupSummary
  | {
      allAgents: true;
      mode: ResolvedSessionMaintenanceConfig["mode"];
      dryRun: boolean;
      stores: SessionCleanupSummary[];
    };

export type SessionsCleanupRunResult = {
  mode: ResolvedSessionMaintenanceConfig["mode"];
  previewResults: Array<{
    summary: SessionCleanupSummary;
    beforeStore: Record<string, SessionEntry>;
    missingKeys: Set<string>;
    staleKeys: Set<string>;
    cappedKeys: Set<string>;
    budgetEvictedKeys: Set<string>;
  }>;
  appliedSummaries: SessionCleanupSummary[];
};

export function resolveSessionCleanupAction(params: {
  key: string;
  missingKeys: Set<string>;
  staleKeys: Set<string>;
  cappedKeys: Set<string>;
  budgetEvictedKeys: Set<string>;
}): SessionCleanupAction {
  if (params.missingKeys.has(params.key)) {
    return "prune-missing";
  }
  if (params.staleKeys.has(params.key)) {
    return "prune-stale";
  }
  if (params.cappedKeys.has(params.key)) {
    return "cap-overflow";
  }
  if (params.budgetEvictedKeys.has(params.key)) {
    return "evict-budget";
  }
  return "keep";
}

export function serializeSessionCleanupResult(params: {
  mode: ResolvedSessionMaintenanceConfig["mode"];
  dryRun: boolean;
  summaries: SessionCleanupSummary[];
}): SessionsCleanupResult {
  if (params.summaries.length === 1) {
    return params.summaries[0] ?? ({} as SessionCleanupSummary);
  }
  return {
    allAgents: true,
    mode: params.mode,
    dryRun: params.dryRun,
    stores: params.summaries,
  };
}

function pruneMissingTranscriptEntries(params: {
  store: Record<string, SessionEntry>;
  storePath: string;
  onPruned?: (key: string) => void;
}): number {
  const sessionPathOpts = resolveSessionFilePathOptions({
    storePath: params.storePath,
  });
  let removed = 0;
  for (const [key, entry] of Object.entries(params.store)) {
    if (!entry?.sessionId) {
      continue;
    }
    const transcriptPath = resolveSessionFilePath(entry.sessionId, entry, sessionPathOpts);
    if (!fs.existsSync(transcriptPath)) {
      delete params.store[key];
      removed += 1;
      params.onPruned?.(key);
    }
  }
  return removed;
}

function addEntryArtifactPathsToSet(params: {
  paths: Set<string>;
  store: Record<string, SessionEntry>;
  storePath: string;
  keys: ReadonlySet<string>;
}): void {
  const sessionsDir = path.dirname(params.storePath);
  for (const key of params.keys) {
    const entry = params.store[key];
    if (!entry) {
      continue;
    }
    for (const artifactPath of resolveSessionArtifactCanonicalPathsForEntry({
      sessionsDir,
      entry,
    })) {
      params.paths.add(artifactPath);
    }
  }
}

async function previewStoreCleanup(params: {
  target: SessionStoreTarget;
  maintenance: ResolvedSessionMaintenanceConfig;
  mode: ResolvedSessionMaintenanceConfig["mode"];
  dryRun: boolean;
  activeKey?: string;
  fixMissing?: boolean;
}) {
  const beforeStore = loadSessionStore(params.target.storePath, { skipCache: true });
  const previewStore = cloneSessionStoreRecord(beforeStore);
  const staleKeys = new Set<string>();
  const cappedKeys = new Set<string>();
  const missingKeys = new Set<string>();
  const missing =
    params.fixMissing === true
      ? pruneMissingTranscriptEntries({
          store: previewStore,
          storePath: params.target.storePath,
          onPruned: (key) => {
            missingKeys.add(key);
          },
        })
      : 0;
  const pruned = pruneStaleEntries(previewStore, params.maintenance.pruneAfterMs, {
    log: false,
    onPruned: ({ key }) => {
      staleKeys.add(key);
    },
  });
  const capped = capEntryCount(previewStore, params.maintenance.maxEntries, {
    log: false,
    onCapped: ({ key }) => {
      cappedKeys.add(key);
    },
  });
  const entryCleanupArtifactPaths = new Set<string>();
  addEntryArtifactPathsToSet({
    paths: entryCleanupArtifactPaths,
    store: beforeStore,
    storePath: params.target.storePath,
    keys: staleKeys,
  });
  addEntryArtifactPathsToSet({
    paths: entryCleanupArtifactPaths,
    store: beforeStore,
    storePath: params.target.storePath,
    keys: cappedKeys,
  });
  const beforeBudgetStore = cloneSessionStoreRecord(previewStore);
  const budgetRemovedFilePaths = new Set<string>();
  const diskBudget = await enforceSessionDiskBudget({
    store: previewStore,
    storePath: params.target.storePath,
    activeSessionKey: params.activeKey,
    maintenance: params.maintenance,
    warnOnly: false,
    dryRun: true,
    onRemoveFile: (canonicalPath) => {
      budgetRemovedFilePaths.add(canonicalPath);
    },
  });
  const unreferencedArtifacts = await pruneUnreferencedSessionArtifacts({
    store: previewStore,
    storePath: params.target.storePath,
    olderThanMs: params.maintenance.pruneAfterMs,
    dryRun: true,
    excludeCanonicalPaths: new Set([...budgetRemovedFilePaths, ...entryCleanupArtifactPaths]),
  });
  const budgetEvictedKeys = new Set<string>();
  for (const key of Object.keys(beforeBudgetStore)) {
    if (!Object.hasOwn(previewStore, key)) {
      budgetEvictedKeys.add(key);
    }
  }
  const beforeCount = Object.keys(beforeStore).length;
  const afterPreviewCount = Object.keys(previewStore).length;
  const wouldMutate =
    missing > 0 ||
    pruned > 0 ||
    capped > 0 ||
    unreferencedArtifacts.removedFiles > 0 ||
    (diskBudget?.removedEntries ?? 0) > 0 ||
    (diskBudget?.removedFiles ?? 0) > 0;

  const summary: SessionCleanupSummary = {
    agentId: params.target.agentId,
    storePath: params.target.storePath,
    mode: params.mode,
    dryRun: params.dryRun,
    beforeCount,
    afterCount: afterPreviewCount,
    missing,
    pruned,
    capped,
    unreferencedArtifacts,
    diskBudget,
    wouldMutate,
  };

  return {
    summary,
    beforeStore,
    missingKeys,
    staleKeys,
    cappedKeys,
    budgetEvictedKeys,
  };
}

export async function runSessionsCleanup(params: {
  cfg: OpenClawConfig;
  opts: SessionsCleanupOptions;
  targets?: SessionStoreTarget[];
}): Promise<SessionsCleanupRunResult> {
  const { cfg, opts } = params;
  const maintenance = resolveMaintenanceConfig();
  const mode = opts.enforce ? "enforce" : maintenance.mode;
  const targets =
    params.targets ??
    resolveSessionStoreTargets(cfg, {
      store: opts.store,
      agent: opts.agent,
      allAgents: opts.allAgents,
    });

  const previewResults: SessionsCleanupRunResult["previewResults"] = [];
  for (const target of targets) {
    const result = await previewStoreCleanup({
      target,
      maintenance,
      mode,
      dryRun: Boolean(opts.dryRun),
      activeKey: opts.activeKey,
      fixMissing: Boolean(opts.fixMissing),
    });
    previewResults.push(result);
  }

  const appliedSummaries: SessionCleanupSummary[] = [];
  if (!opts.dryRun) {
    for (const target of targets) {
      const appliedReportRef: { current: SessionMaintenanceApplyReport | null } = {
        current: null,
      };
      const missingApplied = await updateSessionStore(
        target.storePath,
        async (store) => {
          if (!opts.fixMissing) {
            return 0;
          }
          return pruneMissingTranscriptEntries({
            store,
            storePath: target.storePath,
          });
        },
        {
          activeSessionKey: opts.activeKey,
          maintenanceOverride: {
            mode,
          },
          onMaintenanceApplied: (report) => {
            appliedReportRef.current = report;
          },
        },
      );
      const afterStore = loadSessionStore(target.storePath, { skipCache: true });
      const unreferencedArtifacts =
        mode === "warn"
          ? {
              scannedFiles: 0,
              removedFiles: 0,
              freedBytes: 0,
              olderThanMs: maintenance.pruneAfterMs,
            }
          : await pruneUnreferencedSessionArtifacts({
              store: afterStore,
              storePath: target.storePath,
              olderThanMs: maintenance.pruneAfterMs,
              dryRun: false,
            });
      const preview = previewResults.find(
        (result) => result.summary.storePath === target.storePath,
      );
      const appliedReport = appliedReportRef.current;
      const summary: SessionCleanupSummary =
        appliedReport === null
          ? {
              ...(preview?.summary ?? {
                agentId: target.agentId,
                storePath: target.storePath,
                mode,
                dryRun: false,
                beforeCount: 0,
                afterCount: 0,
                missing: 0,
                pruned: 0,
                capped: 0,
                unreferencedArtifacts,
                diskBudget: null,
                wouldMutate: false,
              }),
              dryRun: false,
              unreferencedArtifacts,
              wouldMutate:
                (preview?.summary.wouldMutate ?? false) || unreferencedArtifacts.removedFiles > 0,
              applied: true,
              appliedCount: Object.keys(afterStore).length,
            }
          : {
              agentId: target.agentId,
              storePath: target.storePath,
              mode: appliedReport.mode,
              dryRun: false,
              beforeCount: appliedReport.beforeCount,
              afterCount: appliedReport.afterCount,
              missing: missingApplied,
              pruned: appliedReport.pruned,
              capped: appliedReport.capped,
              unreferencedArtifacts,
              diskBudget: appliedReport.diskBudget,
              wouldMutate:
                missingApplied > 0 ||
                appliedReport.pruned > 0 ||
                appliedReport.capped > 0 ||
                unreferencedArtifacts.removedFiles > 0 ||
                (appliedReport.diskBudget?.removedEntries ?? 0) > 0 ||
                (appliedReport.diskBudget?.removedFiles ?? 0) > 0,
              applied: true,
              appliedCount: Object.keys(afterStore).length,
            };
      appliedSummaries.push(summary);
    }
  }

  return { mode, previewResults, appliedSummaries };
}

/** Purge session store entries for a deleted agent (#65524). Best-effort. */
export async function purgeAgentSessionStoreEntries(
  cfg: OpenClawConfig,
  agentId: string,
): Promise<void> {
  try {
    const normalizedAgentId = normalizeAgentId(agentId);
    const storeConfig = cfg.session?.store;
    const storeAgentId =
      typeof storeConfig === "string" && storeConfig.includes("{agentId}")
        ? normalizedAgentId
        : normalizeAgentId(resolveDefaultAgentId(cfg));
    const storePath = resolveStorePath(cfg.session?.store, { agentId: normalizedAgentId });
    await updateSessionStore(storePath, (store) => {
      for (const key of Object.keys(store)) {
        if (
          resolveStoredSessionOwnerAgentId({
            cfg,
            agentId: storeAgentId,
            sessionKey: key,
          }) === normalizedAgentId
        ) {
          delete store[key];
        }
      }
    });
  } catch (err) {
    getLogger().debug("session store purge skipped during agent delete", err);
  }
}
