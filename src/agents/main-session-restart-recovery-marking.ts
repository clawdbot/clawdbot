import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  type InternalSessionEntry as SessionEntry,
  type RestartRecoveryRun,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionFilePath,
  resolveSessionTranscriptPathInDir,
} from "../config/sessions.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewaySessionStoreTarget } from "../gateway/session-utils.js";
import {
  getAgentEventLifecycleGeneration,
  listAgentRunsForSession,
} from "../infra/agent-events.js";
import {
  listActiveEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys,
} from "./embedded-agent-runner/run-state.js";
import {
  normalizeMainSessionRecoveryRunFences,
  transitionMainSessionRecovery,
} from "./main-session-recovery-state.js";
import {
  hasCurrentProcessOwner,
  log,
  normalizeFiniteTimestamp,
  normalizeStringSet,
  resolveRestartRecoveryStorePaths,
  shouldSkipMainRecovery,
} from "./main-session-restart-recovery-shared.js";
import { resolveAgentSessionDirs } from "./session-dirs.js";
import type { SessionLockInspection } from "./session-write-lock.js";

function normalizeTranscriptLockPath(lockPath: string): string | undefined {
  const trimmed = lockPath.trim();
  if (!path.basename(trimmed).endsWith(".jsonl.lock")) {
    return undefined;
  }
  const resolved = path.resolve(trimmed);
  try {
    return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  } catch {
    return resolved;
  }
}

function resolveEntryTranscriptLockPaths(params: {
  entry: SessionEntry;
  sessionsDir: string;
}): string[] {
  const paths = new Set<string>();
  const push = (resolvePath: () => string) => {
    try {
      paths.add(path.resolve(`${resolvePath()}.lock`));
    } catch {
      // Keep restart recovery best-effort when session metadata is stale.
    }
  };
  push(() =>
    resolveSessionFilePath(params.entry.sessionId, params.entry, {
      sessionsDir: params.sessionsDir,
    }),
  );
  push(() => resolveSessionTranscriptPathInDir(params.entry.sessionId, params.sessionsDir));
  return [...paths];
}

export async function markRestartAbortedMainSessions(params: {
  cfg?: OpenClawConfig;
  additionalCfgs?: Iterable<OpenClawConfig | undefined>;
  stateDir?: string;
  sessionKeys?: Iterable<string>;
  sessionIds?: Iterable<string>;
  activeRuns?: Iterable<
    RestartRecoveryRun & {
      sessionKey: string;
      sessionId: string;
      observedAt?: number;
    }
  >;
  isActiveRun?: (
    run: RestartRecoveryRun & {
      sessionKey: string;
      sessionId: string;
      observedAt?: number;
    },
  ) => boolean;
  reason?: string;
}): Promise<{ marked: number; skipped: number }> {
  const sessionKeys = normalizeStringSet(params.sessionKeys);
  const sessionIds = normalizeStringSet(params.sessionIds);
  const preferSessionIdMatch = sessionIds.size > 0;
  const activeRuns = [...(params.activeRuns ?? [])]
    .map((run) => ({
      runId: run.runId.trim(),
      lifecycleGeneration: run.lifecycleGeneration.trim(),
      sessionKey: run.sessionKey.trim(),
      sessionId: run.sessionId.trim(),
      observedAt: normalizeFiniteTimestamp(run.observedAt),
    }))
    .filter((run) => run.runId && run.lifecycleGeneration && (run.sessionKey || run.sessionId));
  const currentLifecycleGeneration = getAgentEventLifecycleGeneration();
  const result = { marked: 0, skipped: 0 };
  if (sessionKeys.size === 0 && sessionIds.size === 0) {
    return result;
  }

  const storePaths = new Set<string>();
  const env =
    params.stateDir === undefined
      ? process.env
      : { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  const stateDir = resolveStateDir(env);
  const configs = [params.cfg, ...(params.additionalCfgs ?? [])].filter(
    (cfg): cfg is OpenClawConfig => Boolean(cfg),
  );
  for (const cfg of configs) {
    try {
      for (const target of resolveAllAgentSessionStoreTargetsSync(cfg, { env })) {
        storePaths.add(path.resolve(target.storePath));
      }
    } catch (err) {
      log.warn(`failed to resolve configured session stores for restart marker: ${String(err)}`);
    }
    for (const sessionKey of sessionKeys) {
      try {
        const target = resolveGatewaySessionStoreTarget({
          cfg,
          key: sessionKey,
        });
        storePaths.add(path.resolve(target.storePath));
        for (const storeKey of target.storeKeys) {
          const trimmed = storeKey.trim();
          if (trimmed) {
            sessionKeys.add(trimmed);
          }
        }
      } catch (err) {
        log.warn(
          `failed to resolve session store for restart marker ${sessionKey}: ${String(err)}`,
        );
      }
    }
  }

  for (const sessionsDir of await resolveAgentSessionDirs(stateDir)) {
    storePaths.add(path.join(sessionsDir, "sessions.json"));
  }

  for (const storePath of storePaths) {
    const storeResult = await applySessionEntryReplacements({
      storePath,
      requireWriteSuccess: true,
      update: (entries) => {
        const replacements: Array<{ sessionKey: string; entry: SessionEntry }> = [];
        const counts = { marked: 0, skipped: 0 };
        for (const { sessionKey, entry } of entries) {
          const registeredActiveRuns = listAgentRunsForSession({
            sessionKey,
            sessionId: entry.sessionId,
          });
          const matchingActiveRuns = activeRuns.filter(
            (run) =>
              (run.sessionId ? run.sessionId === entry.sessionId : run.sessionKey === sessionKey) &&
              (entry.status === "running" ||
                run.observedAt === undefined ||
                normalizeFiniteTimestamp(entry.updatedAt) === undefined ||
                (entry.updatedAt < run.observedAt &&
                  run.lifecycleGeneration !== currentLifecycleGeneration)) &&
              params.isActiveRun?.(run) !== false,
          );
          if (
            entry.status !== "running" &&
            matchingActiveRuns.length === 0 &&
            registeredActiveRuns.length === 0
          ) {
            continue;
          }
          const matches =
            typeof entry.sessionId === "string" && sessionIds.has(entry.sessionId)
              ? true
              : !preferSessionIdMatch && sessionKeys.has(sessionKey);
          if (!matches) {
            continue;
          }
          if (shouldSkipMainRecovery(entry, sessionKey)) {
            counts.skipped++;
            continue;
          }
          const wasRunning = entry.status === "running";
          entry.restartRecoveryRuns = normalizeMainSessionRecoveryRunFences([
            ...(entry.restartRecoveryRuns ?? []).filter(
              (run) => run.lifecycleGeneration === currentLifecycleGeneration,
            ),
            ...registeredActiveRuns,
            ...matchingActiveRuns.map(({ runId, lifecycleGeneration }) => ({
              runId,
              lifecycleGeneration,
            })),
          ]);
          transitionMainSessionRecovery(entry, {
            kind: "mark_interrupted",
            cycleId: randomUUID(),
            now: Date.now(),
            resetRuntime: !wasRunning,
            runs: entry.restartRecoveryRuns,
          });
          replacements.push({ sessionKey, entry });
          counts.marked++;
        }
        return { result: counts, replacements };
      },
    });
    result.marked += storeResult.marked;
    result.skipped += storeResult.skipped;
  }

  if (result.marked > 0) {
    log.warn(
      `marked ${result.marked} interrupted main session(s) for restart recovery${
        params.reason ? ` (${params.reason})` : ""
      }`,
    );
  }
  return result;
}

export async function markStartupOrphanedMainSessionsForRecovery(params: {
  cfg?: OpenClawConfig;
  stateDir?: string;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  updatedBeforeMs?: number;
}): Promise<{ marked: number; skipped: number }> {
  const result = { marked: 0, skipped: 0 };
  const providedActiveSessionIds =
    params.activeSessionIds === undefined ? undefined : normalizeStringSet(params.activeSessionIds);
  const providedActiveSessionKeys =
    params.activeSessionKeys === undefined
      ? undefined
      : normalizeStringSet(params.activeSessionKeys);
  const updatedBeforeMs = normalizeFiniteTimestamp(params.updatedBeforeMs);
  // Lifecycle rotation synchronously evicts stale owners, so this same registry
  // view drives both operational routing and recovery suppression. Re-read it at
  // each check so a newer owner can still fence an older async recovery scan.
  const resolveActiveSessionIds = () =>
    providedActiveSessionIds ?? normalizeStringSet(listActiveEmbeddedRunSessionIds());
  const resolveActiveSessionKeys = () =>
    providedActiveSessionKeys ?? normalizeStringSet(listActiveEmbeddedRunSessionKeys());

  for (const storePath of await resolveRestartRecoveryStorePaths(params)) {
    const storeResult = await applySessionEntryReplacements({
      storePath,
      statuses: ["running"],
      update: (entries) => {
        const replacements: Array<{ sessionKey: string; entry: SessionEntry }> = [];
        const counts = { marked: 0, skipped: 0 };
        for (const { sessionKey, entry } of entries) {
          if (entry.status !== "running" || entry.abortedLastRun === true) {
            continue;
          }
          if (shouldSkipMainRecovery(entry, sessionKey)) {
            counts.skipped++;
            continue;
          }
          const updatedAt = normalizeFiniteTimestamp(entry.updatedAt);
          if (
            updatedBeforeMs !== undefined &&
            updatedAt !== undefined &&
            updatedAt > updatedBeforeMs
          ) {
            continue;
          }
          if (
            hasCurrentProcessOwner({
              activeSessionIds: resolveActiveSessionIds(),
              activeSessionKeys: resolveActiveSessionKeys(),
              entry,
              sessionKey,
            })
          ) {
            continue;
          }
          transitionMainSessionRecovery(entry, {
            kind: "mark_interrupted",
            cycleId: randomUUID(),
            now: Date.now(),
          });
          replacements.push({ sessionKey, entry });
          counts.marked++;
        }
        return { result: counts, replacements };
      },
    });
    result.marked += storeResult.marked;
    result.skipped += storeResult.skipped;
  }

  if (result.marked > 0) {
    log.warn(`marked ${result.marked} startup-orphaned main session(s) for restart recovery`);
  }
  return result;
}

export async function markRestartAbortedMainSessionsFromLocks(params: {
  sessionsDir: string;
  cleanedLocks: SessionLockInspection[];
}): Promise<{ marked: number; skipped: number }> {
  const result = { marked: 0, skipped: 0 };
  const sessionsDir = path.resolve(params.sessionsDir);
  const interruptedLockPaths = new Set(
    params.cleanedLocks
      .map((lock) => normalizeTranscriptLockPath(lock.lockPath))
      .filter((lockPath): lockPath is string => Boolean(lockPath)),
  );
  if (interruptedLockPaths.size === 0) {
    return result;
  }

  const storePath = path.join(sessionsDir, "sessions.json");
  const storeResult = await applySessionEntryReplacements({
    storePath,
    statuses: ["running"],
    update: (entries) => {
      const replacements: Array<{ sessionKey: string; entry: SessionEntry }> = [];
      const counts = { marked: 0, skipped: 0 };
      for (const { sessionKey, entry } of entries) {
        if (entry.status !== "running") {
          continue;
        }
        if (shouldSkipMainRecovery(entry, sessionKey)) {
          counts.skipped++;
          continue;
        }
        const entryLockPaths = resolveEntryTranscriptLockPaths({ entry, sessionsDir });
        if (!entryLockPaths.some((lockPath) => interruptedLockPaths.has(lockPath))) {
          continue;
        }
        transitionMainSessionRecovery(entry, {
          kind: "mark_interrupted",
          cycleId: randomUUID(),
          now: Date.now(),
        });
        replacements.push({ sessionKey, entry });
        counts.marked++;
      }
      return { result: counts, replacements };
    },
  });
  result.marked += storeResult.marked;
  result.skipped += storeResult.skipped;

  if (result.marked > 0) {
    log.warn(`marked ${result.marked} interrupted main session(s) from stale transcript locks`);
  }
  return result;
}
