/**
 * Subagent list builder.
 *
 * Combines live registry runs and persisted session metadata for sessions_list/subagents views.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  resolveSubagentLabel,
  sortSubagentRuns,
} from "../../../auto-reply/reply/subagents-utils.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { listSessionEntriesReadOnly } from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatDurationCompact } from "../../../infra/format-time/format-duration.js";
import { resolveUserPath } from "../../../infra/home-dir.js";
import { parseAgentSessionKey, type ParsedAgentSessionKey } from "../../../routing/session-key.js";
import {
  formatTokenUsageDisplay,
  resolveTotalTokens,
  truncateLine,
} from "../../../shared/subagents-format.js";
import { resolveModelDisplayName, resolveModelDisplayRef } from "../../model-selection-display.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { buildSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
} from "./subagent-registry-read.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  isLiveUnendedSubagentRun,
  shouldKeepSubagentRunChildLink,
} from "./subagent-run-liveness.js";
import { resolveSubagentDisplayStatus } from "./subagent-session-metrics.js";

/**
 * Advisory marker for live sibling runs spawned into one working directory.
 * Present only when the spawner passed an explicit `cwd`; inherited workspaces
 * are shared by design and are never reported.
 */
type SubagentSharedCwd = {
  path: string;
  peerRunIds: string[];
};

type SubagentListItem = {
  index: number;
  line: string;
  runId: string;
  sessionKey: string;
  taskName?: string;
  label: string;
  task: string;
  status: string;
  pendingDescendants: number;
  runtime: string;
  runtimeMs: number;
  childSessions?: string[];
  model?: string;
  totalTokens?: number;
  startedAt?: number;
  endedAt?: number;
  sharedCwd?: SubagentSharedCwd;
};

type BuiltSubagentList = {
  total: number;
  active: SubagentListItem[];
  recent: SubagentListItem[];
  text: string;
};

type SessionEntryResolution = {
  storePath: string;
  entry: SessionEntry | undefined;
};

function resolveStorePathForKey(cfg: OpenClawConfig, parsed?: ParsedAgentSessionKey | null) {
  return resolveSessionStorePathCore(cfg.session?.store, {
    agentId: parsed?.agentId,
  });
}

/** Resolve persisted session metadata for a session key, caching per store path. */
export function resolveSessionEntryForKey(params: {
  cfg: OpenClawConfig;
  key: string;
  cache: Map<string, Record<string, SessionEntry>>;
}): SessionEntryResolution {
  const parsed = parseAgentSessionKey(params.key);
  const storePath = resolveStorePathForKey(params.cfg, parsed);
  let store = params.cache.get(storePath);
  if (!store) {
    store = Object.fromEntries(
      listSessionEntriesReadOnly({ storePath, clone: false }).map(({ sessionKey, entry }) => [
        sessionKey,
        entry,
      ]),
    );
    params.cache.set(storePath, store);
  }
  return {
    storePath,
    entry: store[params.key],
  };
}

/** Build child-session indexes from the latest run associated with each child key. */
function buildLatestSubagentRunIndex(
  runs: Map<string, SubagentRunRecord>,
  options?: { now?: number },
) {
  const now = options?.now ?? Date.now();
  const readIndex = buildSubagentRunReadIndexFromRuns({ runs, now });
  const latestByChildSessionKey = new Map(readIndex.latestRunsByChildSessionKey);

  const childSessionsByController = new Map<string, string[]>();
  for (const [childSessionKey, entry] of latestByChildSessionKey.entries()) {
    const controllerSessionKey =
      entry.controllerSessionKey?.trim() || entry.requesterSessionKey?.trim();
    if (!controllerSessionKey) {
      continue;
    }
    if (
      !shouldKeepSubagentRunChildLink(entry, {
        activeDescendants: readIndex.countActiveDescendantRuns(childSessionKey),
        now,
      })
    ) {
      // Completed child links age out unless active descendants still depend on
      // the controller relationship.
      continue;
    }
    const existing = childSessionsByController.get(controllerSessionKey);
    if (existing) {
      existing.push(childSessionKey);
      continue;
    }
    childSessionsByController.set(controllerSessionKey, [childSessionKey]);
  }
  for (const [controllerSessionKey, childSessions] of childSessionsByController) {
    childSessionsByController.set(controllerSessionKey, childSessions.toSorted());
  }

  return {
    latestByChildSessionKey,
    childSessionsByController,
    readIndex,
  };
}

/** Case-fold the grouping key only where the platform filesystem is case-insensitive. */
function sharedCwdGroupKey(resolved: string) {
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Index live runs by the explicit working directory they were spawned into.
 *
 * Reads `spawnedCwd` off the already-cached session entry, so this costs no new
 * I/O and never probes the filesystem. Runs without an explicit `spawnedCwd`
 * inherited the parent workspace — the default for `collect` swarms — and are
 * skipped so the advisory stays silent on normal usage.
 */
function buildSharedCwdIndex(params: {
  cfg: OpenClawConfig;
  runs: SubagentRunRecord[];
  cache: Map<string, Record<string, SessionEntry>>;
  now: number;
}) {
  const groups = new Map<string, { path: string; runIds: string[] }>();
  const groupKeyByRunId = new Map<string, string>();
  for (const run of params.runs) {
    if (!isLiveUnendedSubagentRun(run, params.now)) {
      continue;
    }
    const spawnedCwd = resolveSessionEntryForKey({
      cfg: params.cfg,
      key: run.childSessionKey,
      cache: params.cache,
    }).entry?.spawnedCwd?.trim();
    if (!spawnedCwd) {
      continue;
    }
    const resolved = resolveUserPath(spawnedCwd);
    if (!resolved) {
      continue;
    }
    const groupKey = sharedCwdGroupKey(resolved);
    groupKeyByRunId.set(run.runId, groupKey);
    const existing = groups.get(groupKey);
    if (existing) {
      existing.runIds.push(run.runId);
      continue;
    }
    groups.set(groupKey, { path: resolved, runIds: [run.runId] });
  }
  return (runId: string): SubagentSharedCwd | undefined => {
    const groupKey = groupKeyByRunId.get(runId);
    const group = groupKey ? groups.get(groupKey) : undefined;
    if (!group || group.runIds.length < 2) {
      return undefined;
    }
    return {
      path: group.path,
      peerRunIds: group.runIds.filter((peerRunId) => peerRunId !== runId),
    };
  };
}

/** Return whether a run should be shown in the active subagent section. */
function isActiveSubagentRun(
  entry: SubagentRunRecord,
  pendingDescendantCount: (sessionKey: string) => number,
) {
  return isLiveUnendedSubagentRun(entry) || pendingDescendantCount(entry.childSessionKey) > 0;
}

function resolveModelRef(entry?: SessionEntry, fallbackModel?: string) {
  return resolveModelDisplayRef({
    runtimeProvider: entry?.modelProvider,
    runtimeModel: entry?.model,
    overrideProvider: entry?.providerOverride,
    overrideModel: entry?.modelOverride,
    fallbackModel,
  });
}

function resolveModelDisplay(entry?: SessionEntry, fallbackModel?: string) {
  return resolveModelDisplayName({
    runtimeProvider: entry?.modelProvider,
    runtimeModel: entry?.model,
    overrideProvider: entry?.providerOverride,
    overrideModel: entry?.modelOverride,
    fallbackModel,
  });
}

function buildListText(params: {
  active: Array<{ line: string }>;
  recent: Array<{ line: string }>;
  recentMinutes: number;
}) {
  const lines: string[] = [];
  lines.push("active subagents:");
  if (params.active.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(...params.active.map((entry) => entry.line));
  }
  lines.push("");
  lines.push(`recent (last ${params.recentMinutes}m):`);
  if (params.recent.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(...params.recent.map((entry) => entry.line));
  }
  return lines.join("\n");
}

/** Build structured and text views for active and recent subagent runs. */
export function buildSubagentList(params: {
  cfg: OpenClawConfig;
  runs: SubagentRunRecord[];
  recentMinutes: number;
  taskMaxChars?: number;
}): BuiltSubagentList {
  const now = Date.now();
  const recentCutoff = now - params.recentMinutes * 60_000;
  const dedupedRuns: SubagentRunRecord[] = [];
  const seenChildSessionKeys = new Set<string>();
  for (const entry of sortSubagentRuns(params.runs)) {
    if (seenChildSessionKeys.has(entry.childSessionKey)) {
      continue;
    }
    // Multiple records can point at one child session after steering or retry;
    // the sorted first entry is the display authority.
    seenChildSessionKeys.add(entry.childSessionKey);
    dedupedRuns.push(entry);
  }
  const cache = new Map<string, Record<string, SessionEntry>>();
  const resolveSharedCwd = buildSharedCwdIndex({
    cfg: params.cfg,
    runs: dedupedRuns,
    cache,
    now,
  });
  const snapshot = getSubagentRunsSnapshotForRead(subagentRuns);
  const { childSessionsByController, readIndex } = buildLatestSubagentRunIndex(snapshot);
  const pendingDescendantCount = (sessionKey: string) =>
    readIndex.countPendingDescendantRuns(sessionKey);
  let index = 1;
  const buildListEntry = (entry: SubagentRunRecord, runtimeMs: number) => {
    const sessionEntry = resolveSessionEntryForKey({
      cfg: params.cfg,
      key: entry.childSessionKey,
      cache,
    }).entry;
    const totalTokens = resolveTotalTokens(sessionEntry);
    const usageText = formatTokenUsageDisplay(sessionEntry);
    const pendingDescendants = pendingDescendantCount(entry.childSessionKey);
    const status = resolveSubagentDisplayStatus(entry, pendingDescendants);
    const childSessions = childSessionsByController.get(entry.childSessionKey) ?? [];
    const runtime = formatDurationCompact(runtimeMs) ?? "n/a";
    const label = truncateLine(resolveSubagentLabel(entry), 48);
    const task = truncateLine(entry.task.trim(), params.taskMaxChars ?? 72);
    const taskName = entry.taskName?.trim();
    const taskNamePrefix = taskName ? `${taskName}: ` : "";
    const sharedCwd = resolveSharedCwd(entry.runId);
    const sharedCwdSuffix = sharedCwd
      ? ` [shared cwd with ${sharedCwd.peerRunIds.length} other run${sharedCwd.peerRunIds.length === 1 ? "" : "s"}: ${sharedCwd.path}]`
      : "";
    const line = `${index}. ${taskNamePrefix}${label} (${resolveModelDisplay(sessionEntry, entry.model)}, ${runtime}${usageText ? `, ${usageText}` : ""}) ${status}${normalizeLowercaseStringOrEmpty(task) !== normalizeLowercaseStringOrEmpty(label) ? ` - ${task}` : ""}${sharedCwdSuffix}`;
    const view: SubagentListItem = {
      index,
      line,
      runId: entry.runId,
      sessionKey: entry.childSessionKey,
      ...(taskName ? { taskName } : {}),
      label,
      task,
      status,
      pendingDescendants,
      runtime,
      runtimeMs,
      ...(childSessions.length > 0 ? { childSessions } : {}),
      model: resolveModelRef(sessionEntry, entry.model),
      totalTokens,
      startedAt: getSubagentSessionStartedAt(entry),
      ...(entry.execution.endedAt ? { endedAt: entry.execution.endedAt } : {}),
      // The structured field is the primary surface: subagents-tool strips
      // `line` from its JSON output, so the suffix alone would reach no caller.
      ...(sharedCwd ? { sharedCwd } : {}),
    };
    index += 1;
    return view;
  };
  const active = dedupedRuns
    .filter((entry) => isActiveSubagentRun(entry, pendingDescendantCount))
    .map((entry) => buildListEntry(entry, getSubagentSessionRuntimeMs(entry, now) ?? 0));
  const recent = dedupedRuns
    .filter(
      (entry) =>
        !isActiveSubagentRun(entry, pendingDescendantCount) &&
        Boolean(entry.execution.endedAt) &&
        (entry.execution.endedAt ?? 0) >= recentCutoff,
    )
    .map((entry) =>
      buildListEntry(
        entry,
        getSubagentSessionRuntimeMs(entry, entry.execution.endedAt ?? now) ?? 0,
      ),
    );
  return {
    total: dedupedRuns.length,
    active,
    recent,
    text: buildListText({ active, recent, recentMinutes: params.recentMinutes }),
  };
}
