// Session cleanup service for store entries and transcript/artifact files.
// Supports dry-run/apply modes, stale pruning, missing transcript fixes, DM-scope retirement, and disk budgets.

import fs from "node:fs";
import path from "node:path";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getLogger } from "../../logging/logger.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  pruneUnreferencedSessionArtifacts,
  resolveSessionArtifactCanonicalPathsForEntry,
  type SessionDiskBudgetSweepResult,
  type SessionUnreferencedArtifactSweepResult,
} from "./disk-budget.js";
import { resolveStorePath } from "./paths.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntries,
  loadTranscriptEventsSync,
  purgeDeletedAgentSessionEntries,
  type SessionEntryLifecycleRemoval,
} from "./session-accessor.js";
import {
  enforceSqliteSessionHistoryDiskBudget,
  inspectSqliteSessionHistoryDiskBudget,
} from "./session-history-eviction.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { collectSessionMaintenancePreserveKeysForStore } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  pruneStaleModelRunEntries,
  pruneStaleEntries,
  shouldPreserveMaintenanceEntry,
  shouldRunModelRunPrune,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
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
  fixDmScope?: boolean;
};

type SessionCleanupAction =
  | "keep"
  | "prune-missing"
  | "prune-model-run"
  | "prune-stale"
  | "cap-overflow"
  | "evict-budget"
  | "retire-dm-scope";

export type SessionCleanupSummary = {
  agentId: string;
  storePath: string;
  mode: ResolvedSessionMaintenanceConfig["mode"];
  dryRun: boolean;
  beforeCount: number;
  afterCount: number;
  missing: number;
  dmScopeRetired: number;
  modelRunPruned: number;
  pruned: number;
  capped: number;
  unreferencedArtifacts: SessionUnreferencedArtifactSweepResult;
  diskBudget: SessionDiskBudgetSweepResult | null;
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

type SessionsCleanupRunResult = {
  mode: ResolvedSessionMaintenanceConfig["mode"];
  previewResults: Array<{
    summary: SessionCleanupSummary;
    beforeStore: Record<string, SessionEntry>;
    missingKeys: Set<string>;
    modelRunPrunedKeys: Set<string>;
    staleKeys: Set<string>;
    cappedKeys: Set<string>;
    budgetEvictedKeys: Set<string>;
    dmScopeRetiredKeys: Set<string>;
  }>;
  appliedSummaries: SessionCleanupSummary[];
};

function resolveCleanupSqlitePath(target: SessionStoreTarget): string {
  return (
    resolveSqliteTargetFromSessionStorePath(target.storePath, { agentId: target.agentId }).path ??
    resolveOpenClawAgentSqlitePath({ agentId: target.agentId })
  );
}

function loadCleanupSessionStore(
  target: SessionStoreTarget,
  options: { createIfMissing?: boolean } = {},
): Record<string, SessionEntry> {
  if (options.createIfMissing !== true && !fs.existsSync(resolveCleanupSqlitePath(target))) {
    return {};
  }
  return Object.fromEntries(
    listSessionEntries({
      agentId: target.agentId,
      storePath: target.storePath,
    }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

function isTranscriptMessageRole(role: unknown): boolean {
  return (
    role === "user" ||
    role === "assistant" ||
    role === "tool" ||
    role === "toolResult" ||
    role === "system"
  );
}

function isTranscriptMessageRecord(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { message?: unknown; role?: unknown; type?: unknown };
  if (record.type === "message") {
    return true;
  }
  if (
    record.type === undefined &&
    record.message &&
    typeof record.message === "object" &&
    isTranscriptMessageRole((record.message as { role?: unknown }).role)
  ) {
    return true;
  }
  return record.type === undefined && isTranscriptMessageRole(record.role);
}

function sqliteTranscriptHasMessageRecords(params: {
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): boolean {
  try {
    return loadTranscriptEventsSync(params).some(isTranscriptMessageRecord);
  } catch {
    return false;
  }
}

/** Resolves the action label for one session key from cleanup key sets. */
export function resolveSessionCleanupAction(params: {
  key: string;
  missingKeys: Set<string>;
  modelRunPrunedKeys: Set<string>;
  staleKeys: Set<string>;
  cappedKeys: Set<string>;
  budgetEvictedKeys: Set<string>;
  dmScopeRetiredKeys: Set<string>;
}): SessionCleanupAction {
  if (params.dmScopeRetiredKeys.has(params.key)) {
    return "retire-dm-scope";
  }
  if (params.missingKeys.has(params.key)) {
    return "prune-missing";
  }
  if (params.modelRunPrunedKeys.has(params.key)) {
    return "prune-model-run";
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

function isMainScopeStaleDirectSessionKey(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  key: string;
  activeKey?: string;
}): boolean {
  if ((params.cfg.session?.dmScope ?? "main") !== "main") {
    return false;
  }
  if (params.activeKey && params.key === params.activeKey) {
    return false;
  }
  const parsed = parseAgentSessionKey(params.key);
  if (!parsed || normalizeAgentId(parsed.agentId) !== normalizeAgentId(params.targetAgentId)) {
    return false;
  }
  const parts = parsed.rest.split(":");
  // A nested agent wrapper is opaque plugin identity, never a stale DM route.
  if (parts[0] === "agent") {
    return false;
  }
  return (
    (parts.length === 2 && parts[0] === "direct" && Boolean(parts[1])) ||
    (parts.length === 3 && Boolean(parts[0]) && parts[1] === "direct" && Boolean(parts[2])) ||
    (parts.length === 4 &&
      Boolean(parts[0]) &&
      Boolean(parts[1]) &&
      parts[2] === "direct" &&
      Boolean(parts[3]))
  );
}

function retireMainScopeDirectSessionEntries(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  targetAgentId: string;
  activeKey?: string;
  onRetired?: (key: string, entry: SessionEntry) => void;
}): number {
  let retired = 0;
  for (const [key, entry] of Object.entries(params.store)) {
    // Scope repair cannot retire a user-shelved archive; deletion stays explicit.
    if (entry.archivedAt !== undefined) {
      continue;
    }
    if (
      isMainScopeStaleDirectSessionKey({
        cfg: params.cfg,
        targetAgentId: params.targetAgentId,
        key,
        activeKey: params.activeKey,
      })
    ) {
      params.onRetired?.(key, entry);
      delete params.store[key];
      retired += 1;
    }
  }
  return retired;
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
  onPruned?: (key: string, entry: SessionEntry) => void;
}): number {
  let removed = 0;
  for (const [key, entry] of Object.entries(params.store)) {
    // `--fix-missing` cannot release harness ownership or delete a user-shelved archive.
    if (
      (entry?.modelSelectionLocked === true || entry?.archivedAt !== undefined) &&
      shouldPreserveMaintenanceEntry({ key, entry })
    ) {
      continue;
    }
    // Explicitly pending supervised sessions may not have written their first transcript row yet.
    if (parseAgentSessionKey(key) && entry.initializationPending === true) {
      continue;
    }
    if (!entry?.sessionId) {
      if (parseAgentSessionKey(key)) {
        // Agent-scoped keys without session ids are valid routing entries; keep them.
        continue;
      }
      delete params.store[key];
      removed += 1;
      params.onPruned?.(key, entry);
      continue;
    }
    if (
      !sqliteTranscriptHasMessageRecords({
        sessionId: entry.sessionId,
        sessionKey: key,
        storePath: params.storePath,
      })
    ) {
      delete params.store[key];
      removed += 1;
      params.onPruned?.(key, entry);
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
  cfg: OpenClawConfig;
  target: SessionStoreTarget;
  maintenance: ResolvedSessionMaintenanceConfig;
  mode: ResolvedSessionMaintenanceConfig["mode"];
  dryRun: boolean;
  activeKey?: string;
  fixMissing?: boolean;
  fixDmScope?: boolean;
}) {
  const beforeStore = loadCleanupSessionStore(params.target, {
    createIfMissing: !params.dryRun,
  });
  // Preview always mutates a clone so dry-run output can report exact counts without touching disk.
  const previewStore = structuredClone(beforeStore);
  const staleKeys = new Set<string>();
  const cappedKeys = new Set<string>();
  const missingKeys = new Set<string>();
  const modelRunPrunedKeys = new Set<string>();
  const dmScopeRetiredKeys = new Set<string>();
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
  const dmScopeRetired =
    params.fixDmScope === true
      ? retireMainScopeDirectSessionEntries({
          cfg: params.cfg,
          store: previewStore,
          targetAgentId: params.target.agentId,
          activeKey: params.activeKey,
          onRetired: (key) => {
            dmScopeRetiredKeys.add(key);
          },
        })
      : 0;
  const preserveSessionKeys = collectSessionMaintenancePreserveKeysForStore({
    storePath: params.target.storePath,
    store: previewStore,
    baseKeys: [params.activeKey],
  });
  const modelRunPruned = shouldRunModelRunPrune({
    maintenance: params.maintenance,
    entryCount: Object.keys(previewStore).length,
    // `sessions cleanup` applies the cap immediately (apply path forces maintenance and the
    // preview caps unconditionally below), so mirror that here: prune stale probes before the
    // forced cap can evict real sessions in their place.
    force: true,
  })
    ? pruneStaleModelRunEntries(previewStore, params.maintenance.modelRunPruneAfterMs, {
        log: false,
        preserveKeys: preserveSessionKeys,
        onPruned: ({ key }) => {
          modelRunPrunedKeys.add(key);
        },
      })
    : 0;
  const pruned = pruneStaleEntries(previewStore, params.maintenance.pruneAfterMs, {
    log: false,
    preserveKeys: preserveSessionKeys,
    onPruned: ({ key }) => {
      staleKeys.add(key);
    },
  });
  const capped = capEntryCount(previewStore, params.maintenance.maxEntries, {
    log: false,
    preserveKeys: preserveSessionKeys,
    onCapped: ({ key }) => {
      cappedKeys.add(key);
    },
  });
  const entryCleanupArtifactPaths = new Set<string>();
  addEntryArtifactPathsToSet({
    paths: entryCleanupArtifactPaths,
    store: beforeStore,
    storePath: params.target.storePath,
    keys: modelRunPrunedKeys,
  });
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
  addEntryArtifactPathsToSet({
    paths: entryCleanupArtifactPaths,
    store: beforeStore,
    storePath: params.target.storePath,
    keys: dmScopeRetiredKeys,
  });
  const diskBudgetPreview = fs.existsSync(resolveCleanupSqlitePath(params.target))
    ? await inspectSqliteSessionHistoryDiskBudget({
        agentId: params.target.agentId,
        storePath: params.target.storePath,
        mode: params.mode,
        maintenance: params.maintenance,
      })
    : { diskBudget: null, wouldMutate: false };
  const diskBudget = diskBudgetPreview.diskBudget;
  const unreferencedArtifacts = await pruneUnreferencedSessionArtifacts({
    store: previewStore,
    storePath: params.target.storePath,
    olderThanMs: params.maintenance.pruneAfterMs,
    dryRun: true,
    excludeCanonicalPaths: entryCleanupArtifactPaths,
  });
  const budgetEvictedKeys = new Set<string>();
  const beforeCount = Object.keys(beforeStore).length;
  const afterPreviewCount = Object.keys(previewStore).length;
  const wouldMutate =
    missing > 0 ||
    dmScopeRetired > 0 ||
    modelRunPruned > 0 ||
    pruned > 0 ||
    capped > 0 ||
    unreferencedArtifacts.removedFiles > 0 ||
    (diskBudget?.removedEntries ?? 0) > 0 ||
    (diskBudget?.removedFiles ?? 0) > 0 ||
    diskBudgetPreview.wouldMutate;

  const summary: SessionCleanupSummary = {
    agentId: params.target.agentId,
    storePath: params.target.storePath,
    mode: params.mode,
    dryRun: params.dryRun,
    beforeCount,
    afterCount: afterPreviewCount,
    missing,
    dmScopeRetired,
    modelRunPruned,
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
    modelRunPrunedKeys,
    staleKeys,
    cappedKeys,
    budgetEvictedKeys,
    dmScopeRetiredKeys,
  };
}

/** Runs session cleanup preview/apply for the selected store targets. */
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
      cfg,
      target,
      maintenance,
      mode,
      dryRun: Boolean(opts.dryRun),
      activeKey: opts.activeKey,
      fixMissing: Boolean(opts.fixMissing),
      fixDmScope: Boolean(opts.fixDmScope),
    });
    previewResults.push(result);
  }

  const appliedSummaries: SessionCleanupSummary[] = [];
  if (!opts.dryRun) {
    for (const target of targets) {
      const applyStore = loadCleanupSessionStore(target, { createIfMissing: true });
      const missingRemovals: SessionEntryLifecycleRemoval[] = [];
      const dmScopeRetiredRemovals: SessionEntryLifecycleRemoval[] = [];
      if (opts.fixMissing) {
        pruneMissingTranscriptEntries({
          store: applyStore,
          storePath: target.storePath,
          onPruned: (sessionKey, entry) => {
            missingRemovals.push({
              sessionKey,
              expectedEntry: structuredClone(entry),
            });
          },
        });
      }
      if (opts.fixDmScope) {
        retireMainScopeDirectSessionEntries({
          cfg,
          store: applyStore,
          targetAgentId: target.agentId,
          activeKey: opts.activeKey,
          onRetired: (sessionKey, entry) => {
            dmScopeRetiredRemovals.push({
              sessionKey,
              expectedEntry: structuredClone(entry),
              archiveRemovedTranscript: true,
            });
          },
        });
      }
      const removals: SessionEntryLifecycleRemoval[] = [
        ...missingRemovals,
        ...dmScopeRetiredRemovals,
      ];
      const lifecycleResult = await applySessionEntryLifecycleMutation({
        storePath: target.storePath,
        removals,
        activeSessionKey: opts.activeKey,
        preserveActiveWork: true,
        maintenanceOverride: {
          ...maintenance,
          mode,
        },
        restrictArchivedTranscriptsToStoreDir: true,
      });
      const postApplyStore = loadCleanupSessionStore(target, { createIfMissing: true });
      const appliedUnreferencedArtifacts =
        mode === "warn"
          ? null
          : await pruneUnreferencedSessionArtifacts({
              store: postApplyStore,
              storePath: target.storePath,
              olderThanMs: maintenance.pruneAfterMs,
              dryRun: false,
            });
      const removedSessionKeys = new Set(lifecycleResult.removedSessionKeys);
      const missingApplied = missingRemovals.filter(({ sessionKey }) =>
        removedSessionKeys.has(sessionKey),
      ).length;
      const dmScopeRetiredApplied = dmScopeRetiredRemovals.filter(({ sessionKey }) =>
        removedSessionKeys.has(sessionKey),
      ).length;
      const unreferencedArtifacts =
        mode === "warn"
          ? {
              scannedFiles: 0,
              removedFiles: 0,
              freedBytes: 0,
              olderThanMs: maintenance.pruneAfterMs,
            }
          : (lifecycleResult.unreferencedArtifacts ??
            appliedUnreferencedArtifacts ?? {
              scannedFiles: 0,
              removedFiles: 0,
              freedBytes: 0,
              olderThanMs: maintenance.pruneAfterMs,
            });
      const appliedDiskBudget = await enforceSqliteSessionHistoryDiskBudget({
        agentId: target.agentId,
        storePath: target.storePath,
        mode,
        maintenance,
      });
      const preview = previewResults.find(
        (result) => result.summary.storePath === target.storePath,
      );
      const appliedReport = lifecycleResult.maintenanceReport;
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
                dmScopeRetired: 0,
                modelRunPruned: 0,
                pruned: 0,
                capped: 0,
                unreferencedArtifacts,
                diskBudget: null,
                wouldMutate: false,
              }),
              dryRun: false,
              unreferencedArtifacts,
              diskBudget: appliedDiskBudget,
              wouldMutate:
                removedSessionKeys.size > 0 ||
                unreferencedArtifacts.removedFiles > 0 ||
                (appliedDiskBudget?.removedEntries ?? 0) > 0 ||
                (appliedDiskBudget?.removedFiles ?? 0) > 0 ||
                // Checkpoint/incremental-vacuum reclamation mutates the store
                // even when no session or archive was removed.
                (appliedDiskBudget != null &&
                  appliedDiskBudget.totalBytesAfter < appliedDiskBudget.totalBytesBefore),
              applied: true,
              appliedCount: lifecycleResult.afterCount,
            }
          : {
              agentId: target.agentId,
              storePath: target.storePath,
              mode: appliedReport.mode,
              dryRun: false,
              beforeCount: appliedReport.beforeCount,
              afterCount: appliedReport.afterCount,
              missing: missingApplied,
              dmScopeRetired: dmScopeRetiredApplied,
              modelRunPruned: appliedReport.modelRunPruned,
              pruned: appliedReport.pruned,
              capped: appliedReport.capped,
              unreferencedArtifacts,
              diskBudget: appliedDiskBudget,
              wouldMutate:
                missingApplied > 0 ||
                dmScopeRetiredApplied > 0 ||
                appliedReport.modelRunPruned > 0 ||
                appliedReport.pruned > 0 ||
                appliedReport.capped > 0 ||
                unreferencedArtifacts.removedFiles > 0 ||
                (appliedDiskBudget?.removedEntries ?? 0) > 0 ||
                (appliedDiskBudget?.removedFiles ?? 0) > 0 ||
                // Checkpoint/incremental-vacuum reclamation mutates the store
                // even when no session or archive was removed.
                (appliedDiskBudget != null &&
                  appliedDiskBudget.totalBytesAfter < appliedDiskBudget.totalBytesBefore),
              applied: true,
              appliedCount: lifecycleResult.afterCount,
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
      typeof storeConfig === "string" && !storeConfig.includes("{agentId}")
        ? normalizeAgentId(resolveDefaultAgentId(cfg))
        : normalizedAgentId;
    const storePath = resolveStorePath(cfg.session?.store, { agentId: normalizedAgentId });
    await purgeDeletedAgentSessionEntries({
      cfg,
      agentId: normalizedAgentId,
      storeAgentId,
      storePath,
    });
  } catch (err) {
    getLogger().debug("session store purge skipped during agent delete", err);
  }
}
