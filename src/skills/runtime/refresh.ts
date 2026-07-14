// Skill runtime refresh helpers reload active skill state and notify subscribers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import chokidar, { type FSWatcher } from "chokidar";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import { resolvePluginSkillDirs } from "../loading/plugin-skills.js";
import {
  resolveAllowedSkillSymlinkTargetRealPaths,
  tryRealpath,
} from "../loading/symlink-targets.js";
import {
  bumpSkillsSnapshotVersion,
  clearSkillsSnapshotVersionForWorkspace,
  resetSkillsRefreshStateForTest,
  setSkillsChangeListenerErrorHandler,
} from "./refresh-state.js";
export { bumpSkillsSnapshotVersion, registerSkillsChangeListener } from "./refresh-state.js";

type SkillsPathWatchState = {
  watcher: FSWatcher;
  depth: number;
  debounceMs: number;
  timer?: ReturnType<typeof setTimeout>;
  pendingPath?: string;
  readonly subscribers: Set<string>;
};

type WatchTarget = {
  path: string;
  depth: number;
  key: string;
};

type WatchTargetCacheEntry = {
  signature: string;
  targets: WatchTarget[];
};

type FileStabilitySnapshot = {
  size: number;
  mtimeMs: number;
};

const log = createSubsystemLogger("gateway/skills");
const GROUPED_SKILLS_WATCH_DEPTH = 6;
const CONFIGURED_ROOT_WATCH_DEPTH = 2;
const MAX_SYMLINK_WATCH_TARGETS_PER_ROOT = 100;
const MAX_SYMLINK_WATCH_DIRECTORY_SCANS_PER_ROOT = 200;
const MAX_SYMLINK_WATCH_RAW_ENTRIES_PER_ROOT = 2_000;
const RAW_SKILL_FILE_POLL_INTERVAL_MS = 100;
// One watcher per unique watched directory. Agent workspaces that include the
// same shared skill root (the global skills dir, the home skills dir, or a
// configured extra/plugin dir) subscribe to the same watcher instead of each
// opening its own, so open file descriptors scale with distinct directories
// rather than with agent count.
const pathWatchers = new Map<string, SkillsPathWatchState>();
// Watch targets each workspace is currently subscribed to, used to reconcile
// subscriptions and to detect watch-target changes across calls.
const workspaceWatchTargets = new Map<string, WatchTarget[]>();
// Resolved nested skill watch roots are filesystem-derived. Cache them so the
// per-turn watcher reconciliation path stays cheap until config or watched
// filesystem changes require a fresh root scan.
const workspaceWatchTargetCache = new Map<string, WatchTargetCacheEntry>();
const workspaceWatchLastEnsuredAt = new Map<string, number>();
// Session turns re-ensure their workspace; entries older than this are treated
// as abandoned subscriptions and evicted by the next ensure call.
const SKILLS_WORKSPACE_WATCH_IDLE_TTL_MS = 60 * 60_000;

setSkillsChangeListenerErrorHandler((err) => {
  log.warn(`skills change listener failed: ${String(err)}`);
});

const DEFAULT_SKILLS_WATCH_IGNORED: RegExp[] = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])dist([\\/]|$)/,
  // Python virtual environments and caches
  /(^|[\\/])\.venv([\\/]|$)/,
  /(^|[\\/])venv([\\/]|$)/,
  /(^|[\\/])__pycache__([\\/]|$)/,
  /(^|[\\/])\.mypy_cache([\\/]|$)/,
  /(^|[\\/])\.pytest_cache([\\/]|$)/,
  // Build artifacts and caches
  /(^|[\\/])build([\\/]|$)/,
  /(^|[\\/])\.cache([\\/]|$)/,
];

function resolveWatchTargets(workspaceDir: string, config?: OpenClawConfig): WatchTarget[] {
  const baseRoots: Array<{ path: string; source: string }> = [];
  if (workspaceDir.trim()) {
    baseRoots.push({ path: path.join(workspaceDir, "skills"), source: "openclaw-workspace" });
    baseRoots.push({
      path: path.join(workspaceDir, ".agents", "skills"),
      source: "agents-skills-project",
    });
  }
  baseRoots.push({ path: path.join(CONFIG_DIR, "skills"), source: "openclaw-managed" });
  baseRoots.push({
    path: path.join(os.homedir(), ".agents", "skills"),
    source: "agents-skills-personal",
  });
  const extraDirsRaw = config?.skills?.load?.extraDirs ?? [];
  const extraDirs = extraDirsRaw
    .map((d) => normalizeOptionalString(d) ?? "")
    .filter(Boolean)
    .map((dir) => resolveUserPath(dir));
  const pluginSkillDirs = resolvePluginSkillDirs({ workspaceDir, config });
  const allowedSymlinkTargetRealPaths = resolveAllowedSkillSymlinkTargetRealPaths(config);
  const signature = JSON.stringify({
    basePaths: baseRoots.map((root) => toWatchRoot(root.path)),
    extraDirs: extraDirs.map(toWatchRoot),
    pluginSkillDirs: pluginSkillDirs.map(toWatchRoot),
    allowSymlinkTargets: allowedSymlinkTargetRealPaths,
  });
  const cached = workspaceWatchTargetCache.get(workspaceDir);
  if (cached?.signature === signature) {
    return cached.targets;
  }

  const targets = new Map<string, WatchTarget>();
  for (const root of baseRoots) {
    addSkillRootWatchTargets(targets, root.path, GROUPED_SKILLS_WATCH_DEPTH);
    addTrustedSymlinkSkillWatchTargets(
      targets,
      root.path,
      root.source,
      allowedSymlinkTargetRealPaths,
      GROUPED_SKILLS_WATCH_DEPTH,
      root.path,
    );
    addTrustedSymlinkSkillWatchTargets(
      targets,
      path.join(root.path, "skills"),
      root.source,
      allowedSymlinkTargetRealPaths,
      GROUPED_SKILLS_WATCH_DEPTH,
      root.path,
    );
  }
  for (const resolved of extraDirs) {
    const rootDepth =
      path.basename(resolved) === "skills"
        ? GROUPED_SKILLS_WATCH_DEPTH
        : CONFIGURED_ROOT_WATCH_DEPTH;
    addSkillRootWatchTargets(targets, resolved, rootDepth);
    addTrustedSymlinkSkillWatchTargets(
      targets,
      resolved,
      "openclaw-extra",
      allowedSymlinkTargetRealPaths,
      rootDepth,
      resolved,
    );
    addTrustedSymlinkSkillWatchTargets(
      targets,
      path.join(resolved, "skills"),
      "openclaw-extra",
      allowedSymlinkTargetRealPaths,
      GROUPED_SKILLS_WATCH_DEPTH,
      resolved,
    );
  }
  for (const dir of pluginSkillDirs) {
    const rootDepth =
      path.basename(dir) === "skills" ? GROUPED_SKILLS_WATCH_DEPTH : CONFIGURED_ROOT_WATCH_DEPTH;
    addSkillRootWatchTargets(targets, dir, rootDepth);
    addTrustedSymlinkSkillWatchTargets(
      targets,
      dir,
      "openclaw-plugin",
      allowedSymlinkTargetRealPaths,
      rootDepth,
      dir,
    );
    addTrustedSymlinkSkillWatchTargets(
      targets,
      path.join(dir, "skills"),
      "openclaw-plugin",
      allowedSymlinkTargetRealPaths,
      GROUPED_SKILLS_WATCH_DEPTH,
      dir,
    );
  }
  const sortedTargets = Array.from(targets.values()).toSorted((a, b) => a.key.localeCompare(b.key));
  workspaceWatchTargetCache.set(workspaceDir, { signature, targets: sortedTargets });
  return sortedTargets;
}

function toWatchRoot(raw: string): string {
  const normalized = raw.replaceAll("\\", "/");
  return normalized.replace(/\/+$/, "") || normalized;
}

function makeWatchTarget(raw: string, depth: number): WatchTarget {
  const watchPath = toWatchRoot(raw);
  return { path: watchPath, depth, key: watchPath };
}

function addWatchTarget(targets: Map<string, WatchTarget>, raw: string, depth: number): void {
  const target = makeWatchTarget(raw, depth);
  const existing = targets.get(target.key);
  if (existing) {
    existing.depth = Math.max(existing.depth, target.depth);
    return;
  }
  targets.set(target.key, target);
}

function addSkillRootWatchTargets(
  targets: Map<string, WatchTarget>,
  root: string,
  rootDepth: number,
): void {
  addWatchTarget(targets, root, watchDepthForPath(root, rootDepth));
  const companionSkillsRoot = path.join(root, "skills");
  addWatchTarget(
    targets,
    companionSkillsRoot,
    watchDepthForPath(companionSkillsRoot, GROUPED_SKILLS_WATCH_DEPTH),
  );
}

function addTrustedSymlinkSkillWatchTargets(
  targets: Map<string, WatchTarget>,
  root: string,
  source: string,
  allowedSymlinkTargetRealPaths: readonly string[],
  maxDepth: number,
  containmentRoot: string,
): void {
  const containmentRootRealPath = tryRealpath(containmentRoot) ?? path.resolve(containmentRoot);
  const rootRealPath = tryRealpath(root) ?? path.resolve(root);
  try {
    if (
      fs.lstatSync(root).isSymbolicLink() &&
      isTrustedSymlinkSkillTarget(
        source,
        containmentRootRealPath,
        rootRealPath,
        allowedSymlinkTargetRealPaths,
      )
    ) {
      addSkillRootWatchTargets(targets, rootRealPath, maxDepth);
    }
  } catch {
    return;
  }
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let watched = 0;
  let directoryScans = 0;
  let rawEntries = 0;
  for (const queued of queue) {
    if (
      watched >= MAX_SYMLINK_WATCH_TARGETS_PER_ROOT ||
      directoryScans >= MAX_SYMLINK_WATCH_DIRECTORY_SCANS_PER_ROOT ||
      rawEntries >= MAX_SYMLINK_WATCH_RAW_ENTRIES_PER_ROOT
    ) {
      break;
    }
    const current = queued;
    if (!current) {
      continue;
    }
    const scan = readBudgetedDirEntries(
      current.dir,
      MAX_SYMLINK_WATCH_RAW_ENTRIES_PER_ROOT - rawEntries,
    );
    directoryScans += 1;
    rawEntries += scan.scannedEntryCount;
    if (!scan.ok) {
      continue;
    }
    for (const entry of scan.entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (watched >= MAX_SYMLINK_WATCH_TARGETS_PER_ROOT) {
        break;
      }
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const childPath = path.join(current.dir, entry.name);
      if (DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(childPath))) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        const targetRealPath = tryRealpath(childPath);
        if (
          targetRealPath &&
          isTrustedSymlinkSkillTarget(
            source,
            containmentRootRealPath,
            targetRealPath,
            allowedSymlinkTargetRealPaths,
          )
        ) {
          addSkillRootWatchTargets(targets, targetRealPath, GROUPED_SKILLS_WATCH_DEPTH);
          watched += 1;
        }
        continue;
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ dir: childPath, depth: current.depth + 1 });
      }
    }
  }
}

function readBudgetedDirEntries(
  dir: string,
  maxEntries: number,
):
  | { ok: true; entries: fs.Dirent[]; scannedEntryCount: number }
  | { ok: false; scannedEntryCount: number } {
  const entries: fs.Dirent[] = [];
  const limit = Math.max(0, maxEntries);
  let handle: fs.Dir | undefined;
  try {
    handle = fs.opendirSync(dir);
    for (let scanned = 0; scanned < limit; scanned += 1) {
      const entry = handle.readSync();
      if (!entry) {
        return { ok: true, entries, scannedEntryCount: scanned };
      }
      entries.push(entry);
    }
    return { ok: true, entries, scannedEntryCount: limit };
  } catch {
    return { ok: false, scannedEntryCount: 0 };
  } finally {
    handle?.closeSync();
  }
}

function isTrustedSymlinkSkillTarget(
  source: string,
  rootRealPath: string,
  targetRealPath: string,
  allowedSymlinkTargetRealPaths: readonly string[],
): boolean {
  if (source === "openclaw-managed" || source === "agents-skills-personal") {
    return true;
  }
  return (
    isPathInside(rootRealPath, targetRealPath) ||
    isPathInsideAnyRoot(allowedSymlinkTargetRealPaths, targetRealPath)
  );
}

function watchDepthForPath(raw: string, depth: number): number {
  let missingSegments = 0;
  let candidate = raw;
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      break;
    }
    missingSegments += 1;
    candidate = parent;
  }
  return depth + missingSegments;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isPathInsideAnyRoot(roots: readonly string[], child: string): boolean {
  return roots.some((root) => isPathInside(root, child));
}

export function shouldIgnoreSkillsWatchPath(
  watchPath: string,
  stats?: { isDirectory?: () => boolean; isSymbolicLink?: () => boolean },
  options: { usePolling?: boolean } = {},
): boolean {
  if (DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(watchPath))) {
    return true;
  }
  if (stats?.isDirectory?.() || stats?.isSymbolicLink?.()) {
    return false;
  }
  if (!stats) {
    return false;
  }
  if (options.usePolling && isSkillFileWatchPath(watchPath)) {
    return false;
  }
  // Regular files are surfaced through raw directory events below. Letting
  // chokidar include SKILL.md here registers per-file watchers and leaks FDs.
  return true;
}

function isSkillFileWatchPath(watchPath: string): boolean {
  if (DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(watchPath))) {
    return false;
  }
  const normalized = watchPath.replaceAll("\\", "/");
  return path.posix.basename(normalized) === "SKILL.md";
}

function getRawWatchedPath(details: unknown): string | undefined {
  return typeof details === "object" &&
    details !== null &&
    typeof (details as { watchedPath?: unknown }).watchedPath === "string"
    ? (details as { watchedPath: string }).watchedPath
    : undefined;
}

function rawPathToString(rawPath: unknown): string | undefined {
  if (typeof rawPath === "string") {
    return rawPath || undefined;
  }
  if (Buffer.isBuffer(rawPath)) {
    const decoded = rawPath.toString();
    return decoded || undefined;
  }
  return undefined;
}

function resolveRawSkillsWatchPath(rawPath: string, details: unknown): string | undefined {
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  const watchedPath = getRawWatchedPath(details);
  return watchedPath ? path.join(watchedPath, rawPath) : undefined;
}

function readFileStabilitySnapshot(filePath: string): FileStabilitySnapshot | undefined {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

async function waitForStableSkillFile(filePath: string, stabilityMs: number): Promise<void> {
  if (stabilityMs <= 0) {
    return;
  }
  let previous = readFileStabilitySnapshot(filePath);
  if (!previous) {
    return;
  }
  let stableForMs = 0;
  while (stableForMs < stabilityMs) {
    const delayMs = Math.min(RAW_SKILL_FILE_POLL_INTERVAL_MS, stabilityMs - stableForMs);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
    const next = readFileStabilitySnapshot(filePath);
    if (!next) {
      return;
    }
    if (next.size === previous.size && next.mtimeMs === previous.mtimeMs) {
      stableForMs += delayMs;
      continue;
    }
    previous = next;
    stableForMs = 0;
  }
}

function resolveWatchDebounceMs(config?: OpenClawConfig): number {
  const raw = config?.skills?.load?.watchDebounceMs;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, raw) : 250;
}

function resolveSkillsWatcherUsePolling(): boolean {
  const envPolling = process.env.CHOKIDAR_USEPOLLING;
  if (envPolling === undefined) {
    const platform: string = process.platform;
    return platform === "os400";
  }
  const normalized = envPolling.toLowerCase();
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  return Boolean(normalized);
}

// Requires resolveWatchTargets to produce a stable-order result (it returns a
// sorted array); positional comparison is intentional for hot-path efficiency.
function sameWatchTargets(a: WatchTarget[], b: WatchTarget[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index++) {
    if (a[index]?.key !== b[index]?.key || a[index]?.depth !== b[index]?.depth) {
      return false;
    }
  }
  return true;
}

function createSkillsPathWatcher(target: WatchTarget, debounceMs: number): SkillsPathWatchState {
  const usePolling = resolveSkillsWatcherUsePolling();
  const watcher = chokidar.watch(target.path, {
    ignoreInitial: true,
    followSymlinks: false,
    usePolling,
    // Skill root precedence and grouped discovery use the same bounded depth,
    // so watcher invalidation must observe that whole decision surface.
    depth: target.depth,
    awaitWriteFinish: {
      stabilityThreshold: debounceMs,
      pollInterval: 100,
    },
    ignored: (watchPath, stats) => shouldIgnoreSkillsWatchPath(watchPath, stats, { usePolling }),
  });

  const state: SkillsPathWatchState = {
    watcher,
    depth: target.depth,
    debounceMs,
    subscribers: new Set<string>(),
  };

  const schedule = (changedPath?: string) => {
    state.pendingPath = changedPath ?? state.pendingPath;
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      const pendingPath = state.pendingPath;
      state.pendingPath = undefined;
      state.timer = undefined;
      // Fan the change out to every workspace subscribed to this directory so a
      // shared skill root refreshes the snapshot for all agents that use it.
      for (const workspaceDir of state.subscribers) {
        workspaceWatchTargetCache.delete(workspaceDir);
        bumpSkillsSnapshotVersion({
          workspaceDir,
          reason: "watch",
          changedPath: pendingPath,
        });
      }
    }, debounceMs);
  };
  const scheduleRawSkillFile = (changedPath: string) => {
    void waitForStableSkillFile(changedPath, debounceMs)
      .catch((err: unknown) => {
        log.warn(`skills watcher stability check failed (${changedPath}): ${String(err)}`);
      })
      .then(() => schedule(changedPath));
  };

  watcher.on("addDir", (p) => schedule(p));
  watcher.on("add", (p) => schedule(p));
  watcher.on("change", (p) => schedule(p));
  watcher.on("unlink", (p) => schedule(p));
  watcher.on("unlinkDir", (p) => schedule(p));
  watcher.on("raw", (_eventName, rawPath, details) => {
    const rawPathText = rawPathToString(rawPath);
    if (!rawPathText) {
      const watchedPath = getRawWatchedPath(details);
      if (watchedPath) {
        schedule(watchedPath);
      }
      return;
    }
    const changedPath = resolveRawSkillsWatchPath(rawPathText, details);
    if (changedPath && isSkillFileWatchPath(changedPath)) {
      if (usePolling) {
        return;
      }
      scheduleRawSkillFile(changedPath);
    }
  });
  watcher.on("error", (err) => {
    log.warn(`skills watcher error (${target.path}): ${String(err)}`);
  });

  return state;
}

function teardownSkillsPathWatcher(state: SkillsPathWatchState): void {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  void state.watcher.close().catch(() => {});
}

function subscribeWorkspaceToPath(
  workspaceDir: string,
  watchTarget: WatchTarget,
  debounceMs: number,
): void {
  const existing = pathWatchers.get(watchTarget.key);
  if (existing && existing.debounceMs === debounceMs && existing.depth >= watchTarget.depth) {
    existing.subscribers.add(workspaceDir);
    return;
  }
  if (existing) {
    // Debounce changed (config reload): rebuild the shared watcher while
    // preserving existing subscribers. Debounce is a gateway-global config
    // value, so all workspaces normally request the same value and this branch
    // does not fire; if it does, the most recent requested debounce wins for
    // every subscriber of the shared path (last-writer-wins).
    const next = createSkillsPathWatcher(
      { ...watchTarget, depth: Math.max(existing.depth, watchTarget.depth) },
      debounceMs,
    );
    for (const subscriber of existing.subscribers) {
      next.subscribers.add(subscriber);
    }
    next.subscribers.add(workspaceDir);
    teardownSkillsPathWatcher(existing);
    pathWatchers.set(watchTarget.key, next);
    return;
  }
  const state = createSkillsPathWatcher(watchTarget, debounceMs);
  state.subscribers.add(workspaceDir);
  pathWatchers.set(watchTarget.key, state);
}

function unsubscribeWorkspaceFromPath(workspaceDir: string, watchTarget: WatchTarget): void {
  const state = pathWatchers.get(watchTarget.key);
  if (!state) {
    return;
  }
  state.subscribers.delete(workspaceDir);
  if (state.subscribers.size === 0) {
    teardownSkillsPathWatcher(state);
    pathWatchers.delete(watchTarget.key);
  }
}

function disposeWorkspaceWatchState(
  workspaceDir: string,
  watchTargets: readonly WatchTarget[] = workspaceWatchTargets.get(workspaceDir) ?? [],
): void {
  const hadWatchTargets = watchTargets.length > 0;
  for (const watchTarget of watchTargets) {
    unsubscribeWorkspaceFromPath(workspaceDir, watchTarget);
  }
  workspaceWatchTargets.delete(workspaceDir);
  workspaceWatchTargetCache.delete(workspaceDir);
  workspaceWatchLastEnsuredAt.delete(workspaceDir);
  if (hadWatchTargets) {
    // Watcher disposal creates an unwatched interval; mark the workspace dirty
    // so the next turn rebuilds skills even if file events were missed.
    bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch-targets" });
  }
  clearSkillsSnapshotVersionForWorkspace(workspaceDir);
}

function evictIdleWorkspaceWatchStates(now: number): void {
  const cutoff = now - SKILLS_WORKSPACE_WATCH_IDLE_TTL_MS;
  for (const [workspaceDir, lastEnsuredAt] of workspaceWatchLastEnsuredAt) {
    if (lastEnsuredAt < cutoff) {
      disposeWorkspaceWatchState(workspaceDir);
    }
  }
}

export function ensureSkillsWatcher(params: { workspaceDir: string; config?: OpenClawConfig }) {
  const workspaceDir = params.workspaceDir.trim();
  if (!workspaceDir) {
    return;
  }
  const now = Date.now();
  const watchEnabled = params.config?.skills?.load?.watch !== false;
  const debounceMs = resolveWatchDebounceMs(params.config);
  const previousTargets = workspaceWatchTargets.get(workspaceDir) ?? [];

  if (!watchEnabled) {
    disposeWorkspaceWatchState(workspaceDir, previousTargets);
    evictIdleWorkspaceWatchStates(now);
    return;
  }

  workspaceWatchLastEnsuredAt.set(workspaceDir, now);
  const watchTargets = resolveWatchTargets(workspaceDir, params.config);
  const targetsUnchanged = sameWatchTargets(previousTargets, watchTargets);
  const debounceUnchanged = watchTargets.every(
    // undefined for paths not yet watched -> false -> fall through to subscribe.
    (watchTarget) => {
      const pathWatcher = pathWatchers.get(watchTarget.key);
      return pathWatcher?.debounceMs === debounceMs && pathWatcher.depth >= watchTarget.depth;
    },
  );
  if (targetsUnchanged && debounceUnchanged) {
    evictIdleWorkspaceWatchStates(now);
    return;
  }
  const watchTargetsChanged = previousTargets.length > 0 && !targetsUnchanged;

  const nextTargetKeys = new Set(watchTargets.map((target) => target.key));
  for (const watchTarget of previousTargets) {
    if (!nextTargetKeys.has(watchTarget.key)) {
      unsubscribeWorkspaceFromPath(workspaceDir, watchTarget);
    }
  }
  for (const watchTarget of watchTargets) {
    subscribeWorkspaceToPath(workspaceDir, watchTarget, debounceMs);
  }
  workspaceWatchTargets.set(workspaceDir, watchTargets);

  if (watchTargetsChanged) {
    bumpSkillsSnapshotVersion({
      workspaceDir,
      reason: "watch-targets",
      changedPath: watchTargets.map((target) => target.path).join("|"),
    });
  }
  evictIdleWorkspaceWatchStates(now);
}

export async function resetSkillsRefreshForTest(): Promise<void> {
  resetSkillsRefreshStateForTest();

  const active = Array.from(pathWatchers.values());
  pathWatchers.clear();
  workspaceWatchTargets.clear();
  workspaceWatchTargetCache.clear();
  workspaceWatchLastEnsuredAt.clear();
  await Promise.all(
    active.map(async (state) => {
      if (state.timer) {
        clearTimeout(state.timer);
      }
      try {
        await state.watcher.close();
      } catch {
        // Best-effort test cleanup.
      }
    }),
  );
}
