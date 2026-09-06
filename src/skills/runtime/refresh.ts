import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import chokidar, { type FSWatcher } from "chokidar";
import { isDefaultStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRealpathOrAbsolute } from "../../infra/boundary-path.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import {
  resolvePluginSkillRoots,
  resolvePluginSkillRootsFromMetadata,
} from "../loading/plugin-skills.js";
import {
  resolveAllowedSkillSymlinkTargetRealPaths,
  tryRealpath,
} from "../loading/symlink-targets.js";
import { createWorkshopWatcherKey, resolveWorkshopWatchRoots } from "../workshop/skills-root.js";
import {
  bumpSkillsSnapshotVersion,
  clearSkillsSnapshotVersionForWorkspace,
  resetSkillsRefreshStateForTest,
  setSkillsChangeListenerErrorHandler,
} from "./refresh-state.js";
import { resolveSkillsWatchPath, toWatchRoot } from "./refresh-watch-path.js";
export { registerSkillsChangeListener } from "./refresh-state.js";

type SkillsPathWatchState = {
  watcher: FSWatcher;
  watchRoot: string;
  depth: number;
  timer?: ReturnType<typeof setTimeout>;
  pendingPath?: string;
  readonly subscribers: Set<string>;
};

type WatchTarget = {
  path: string;
  watchRoot: string;
  depth: number;
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
// Gateway startup imports this owner before serving turns. Shared watcher handles,
// including later rebuilds, must inherit that lifetime rather than the triggering turn.
const runInSkillsWatcherContext = AsyncLocalStorage.snapshot();
const GROUPED_SKILLS_WATCH_DEPTH = 6;
const CONFIGURED_ROOT_WATCH_DEPTH = 2;
const MAX_SYMLINK_WATCH_TARGETS_PER_ROOT = 100;
const MAX_SYMLINK_WATCH_DIRECTORY_SCANS_PER_ROOT = 200;
const MAX_SYMLINK_WATCH_RAW_ENTRIES_PER_ROOT = 2_000;
const RAW_SKILL_FILE_POLL_INTERVAL_MS = 100;
const SKILLS_WATCH_DEBOUNCE_MS = 250;
// One watcher per unique watched directory. Agent workspaces that include the
// same shared skill root (the global skills dir, the home skills dir, or a
// configured extra/plugin dir) subscribe to the same watcher instead of each
// opening its own, so open file descriptors scale with distinct directories
// rather than with agent count.
const pathWatchers = new Map<string, SkillsPathWatchState>();
// Watch targets each workspace is currently subscribed to, used to reconcile
// subscriptions and to detect watch-target changes across calls.
const workspaceWatchTargets = new Map<string, WatchTarget[]>();
// A watcher key may include an execution root, but refresh events and versions
// retain the configured agent workspace as their stable public identity.
const workspaceWatchOwnerDirs = new Map<string, string>();
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

function resolveWatchTargets(
  workspaceDir: string,
  config: OpenClawConfig | undefined,
  agentId: string | undefined,
  executionSkillsDir: string | undefined,
  watcherKey: string,
  pluginMetadataSnapshot: PluginMetadataSnapshot | undefined,
): WatchTarget[] {
  const baseRoots: Array<{ path: string; source: string }> = [];
  if (workspaceDir.trim()) {
    baseRoots.push({ path: path.join(workspaceDir, "skills"), source: "openclaw-workspace" });
    baseRoots.push({
      path: path.join(workspaceDir, ".agents", "skills"),
      source: "agents-skills-project",
    });
  }
  if (executionSkillsDir) {
    baseRoots.push({ path: executionSkillsDir, source: "openclaw-workspace" });
  }
  baseRoots.push(...resolveWorkshopWatchRoots(config, agentId));
  baseRoots.push({ path: path.join(CONFIG_DIR, "skills"), source: "openclaw-managed" });
  if (isDefaultStateDir()) {
    baseRoots.push({
      path: path.join(os.homedir(), ".agents", "skills"),
      source: "agents-skills-personal",
    });
  }
  const extraDirsRaw = config?.skills?.load?.extraDirs ?? [];
  const extraDirs = extraDirsRaw
    .map((d) => normalizeOptionalString(d) ?? "")
    .filter(Boolean)
    .map((dir) => resolveUserPath(dir));
  const pluginSkillRoots = pluginMetadataSnapshot
    ? resolvePluginSkillRootsFromMetadata({
        workspaceDir,
        config,
        metadataSnapshot: pluginMetadataSnapshot,
      })
    : resolvePluginSkillRoots({ workspaceDir, config });
  const pluginSkillDirs = pluginSkillRoots.map((root) => root.dir);
  const allowedSymlinkTargetRealPaths = resolveAllowedSkillSymlinkTargetRealPaths(config);
  const signature = JSON.stringify({
    basePaths: baseRoots.map((root) => toWatchRoot(root.path)),
    extraDirs: extraDirs.map(toWatchRoot),
    pluginSkillDirs: pluginSkillDirs.map(toWatchRoot),
    allowSymlinkTargets: allowedSymlinkTargetRealPaths,
  });
  const cached = workspaceWatchTargetCache.get(watcherKey);
  if (cached?.signature === signature) {
    return cached.targets;
  }

  const targets = new Map<string, WatchTarget>();
  for (const root of baseRoots) {
    addSkillSourceWatchTargets(
      targets,
      root.path,
      root.source,
      allowedSymlinkTargetRealPaths,
      GROUPED_SKILLS_WATCH_DEPTH,
    );
  }
  for (const resolved of extraDirs) {
    addSkillSourceWatchTargets(targets, resolved, "openclaw-extra", allowedSymlinkTargetRealPaths);
  }
  for (const dir of pluginSkillDirs) {
    addSkillSourceWatchTargets(targets, dir, "openclaw-plugin", allowedSymlinkTargetRealPaths);
  }
  const sortedTargets = Array.from(targets.values()).toSorted((a, b) =>
    a.path.localeCompare(b.path),
  );
  workspaceWatchTargetCache.set(watcherKey, { signature, targets: sortedTargets });
  return sortedTargets;
}

function makeWatchTarget(raw: string, depth: number): WatchTarget {
  const watchPath = toWatchRoot(resolveSkillsWatchPath(raw));
  let watchRoot = watchPath;
  while (!fs.existsSync(watchRoot)) {
    const parent = path.dirname(watchRoot);
    if (parent === watchRoot) {
      break;
    }
    watchRoot = parent;
  }
  return { path: watchPath, watchRoot: toWatchRoot(watchRoot), depth };
}

function addWatchTarget(targets: Map<string, WatchTarget>, raw: string, depth: number): void {
  const target = makeWatchTarget(raw, depth);
  target.depth = Math.max(target.depth, targets.get(target.path)?.depth ?? 0);
  targets.set(target.path, target);
}

function addSkillRootWatchTargets(
  targets: Map<string, WatchTarget>,
  root: string,
  rootDepth: number,
): string {
  addWatchTarget(targets, root, rootDepth);
  const companionSkillsRoot = path.join(root, "skills");
  addWatchTarget(targets, companionSkillsRoot, GROUPED_SKILLS_WATCH_DEPTH);
  return companionSkillsRoot;
}

function addSkillSourceWatchTargets(
  targets: Map<string, WatchTarget>,
  root: string,
  source: string,
  allowedSymlinkTargetRealPaths: readonly string[],
  rootDepth = path.basename(root) === "skills"
    ? GROUPED_SKILLS_WATCH_DEPTH
    : CONFIGURED_ROOT_WATCH_DEPTH,
): void {
  const companionSkillsRoot = addSkillRootWatchTargets(targets, root, rootDepth);
  // Both bounded scans share the source's containment identity for this preparation.
  // Trusted symlink leaves below remain registration-only, never recursive scans.
  const rootRealPath = resolveRealpathOrAbsolute(root);
  addTrustedSymlinkSkillWatchTargets(
    targets,
    root,
    source,
    allowedSymlinkTargetRealPaths,
    rootDepth,
    rootRealPath,
    rootRealPath,
  );
  addTrustedSymlinkSkillWatchTargets(
    targets,
    companionSkillsRoot,
    source,
    allowedSymlinkTargetRealPaths,
    GROUPED_SKILLS_WATCH_DEPTH,
    rootRealPath,
    resolveRealpathOrAbsolute(companionSkillsRoot),
  );
}

function addTrustedSymlinkSkillWatchTargets(
  targets: Map<string, WatchTarget>,
  root: string,
  source: string,
  allowedSymlinkTargetRealPaths: readonly string[],
  maxDepth: number,
  containmentRootRealPath: string,
  rootRealPath: string,
): void {
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
    allowedSymlinkTargetRealPaths.some((root) => isPathInside(root, targetRealPath))
  );
}

function shouldIgnoreSkillsWatchPath(
  watchPath: string,
  stats?: { isDirectory?: () => boolean; isSymbolicLink?: () => boolean },
  usePolling = false,
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
  if (usePolling && isSkillFileWatchPath(watchPath)) {
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

async function waitForStableSkillFile(
  filePath: string,
  stabilityMs: number,
  watcher: FSWatcher,
): Promise<void> {
  if (watcher.closed || stabilityMs <= 0) {
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
    // Closing a watcher retires raw polling, even while the file keeps changing.
    const next = watcher.closed ? undefined : readFileStabilitySnapshot(filePath);
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
  return (
    a.length === b.length &&
    a.every(
      (target, index) =>
        target.path === b[index]?.path &&
        target.watchRoot === b[index]?.watchRoot &&
        target.depth === b[index]?.depth,
    )
  );
}

function createSkillsPathWatcher(target: WatchTarget): SkillsPathWatchState {
  const usePolling = resolveSkillsWatcherUsePolling();
  // Chokidar's missing-root fallback retains only the final basename, so it
  // misses creation through multiple absent parents. Watch the existing prefix
  // and restrict traversal to the logical root and its ancestor chain.
  const watcher = runInSkillsWatcherContext(() =>
    chokidar.watch(target.watchRoot, {
      ignoreInitial: true,
      followSymlinks: false,
      usePolling,
      // Skill root precedence and grouped discovery use the same bounded depth,
      // so watcher invalidation must observe that whole decision surface.
      depth:
        target.depth +
        path.relative(target.watchRoot, target.path).split(path.sep).filter(Boolean).length,
      awaitWriteFinish: {
        stabilityThreshold: SKILLS_WATCH_DEBOUNCE_MS,
        pollInterval: 100,
      },
      ignored: (watchPath, stats) =>
        shouldIgnoreSkillsWatchPath(watchPath, stats, usePolling) ||
        (!isPathInside(target.path, watchPath) && !isPathInside(watchPath, target.path)),
    }),
  );

  const state: SkillsPathWatchState = {
    watcher,
    watchRoot: target.watchRoot,
    depth: target.depth,
    subscribers: new Set<string>(),
  };

  const schedule = (changedPath?: string) => {
    // File-stability work may finish after this subscription has been closed.
    if (watcher.closed) {
      return;
    }
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
      for (const watcherKey of state.subscribers) {
        workspaceWatchTargetCache.delete(watcherKey);
        bumpSkillsSnapshotVersion({
          workspaceDir: workspaceWatchOwnerDirs.get(watcherKey) ?? watcherKey,
          reason: "watch",
          changedPath: pendingPath,
        });
      }
    }, SKILLS_WATCH_DEBOUNCE_MS);
  };
  const scheduleRawSkillFile = (changedPath: string) => {
    void waitForStableSkillFile(changedPath, SKILLS_WATCH_DEBOUNCE_MS, watcher)
      .catch((err: unknown) => {
        log.warn(`skills watcher stability check failed (${changedPath}): ${String(err)}`);
      })
      .then(() => schedule(changedPath));
  };

  watcher.on("all", (_event, changedPath) => {
    if (isPathInside(target.path, changedPath) || isPathInside(changedPath, target.path)) {
      schedule(changedPath);
    }
  });
  watcher.on("raw", (_eventName, rawPath, details) => {
    const rawPathText = rawPathToString(rawPath);
    if (!rawPathText) {
      const watchedPath = getRawWatchedPath(details);
      if (watchedPath && isPathInside(target.path, watchedPath)) {
        schedule(watchedPath);
      }
      return;
    }
    const changedPath = resolveRawSkillsWatchPath(rawPathText, details);
    if (
      changedPath &&
      isPathInside(target.path, changedPath) &&
      isSkillFileWatchPath(changedPath)
    ) {
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

async function teardownSkillsPathWatcher(state: SkillsPathWatchState): Promise<void> {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  try {
    await state.watcher.close();
  } catch {
    // Closing watchers is best effort, including during replacement and shutdown.
  }
}

function subscribeWorkspaceToPath(workspaceDir: string, watchTarget: WatchTarget): void {
  const existing = pathWatchers.get(watchTarget.path);
  if (
    existing &&
    existing.watchRoot === watchTarget.watchRoot &&
    existing.depth >= watchTarget.depth
  ) {
    existing.subscribers.add(workspaceDir);
    return;
  }
  if (existing) {
    // A changed ancestor or deeper target needs a rebuilt watcher, preserving subscribers.
    const next = createSkillsPathWatcher({
      ...watchTarget,
      depth: Math.max(existing.depth, watchTarget.depth),
    });
    for (const subscriber of existing.subscribers) {
      next.subscribers.add(subscriber);
    }
    next.subscribers.add(workspaceDir);
    void teardownSkillsPathWatcher(existing);
    pathWatchers.set(watchTarget.path, next);
    return;
  }
  const state = createSkillsPathWatcher(watchTarget);
  state.subscribers.add(workspaceDir);
  pathWatchers.set(watchTarget.path, state);
}

function unsubscribeWorkspaceFromPath(workspaceDir: string, watchTarget: WatchTarget): void {
  const state = pathWatchers.get(watchTarget.path);
  if (!state) {
    return;
  }
  state.subscribers.delete(workspaceDir);
  if (state.subscribers.size === 0) {
    void teardownSkillsPathWatcher(state);
    pathWatchers.delete(watchTarget.path);
  }
}

function disposeWorkspaceWatchState(
  watcherKey: string,
  watchTargets: readonly WatchTarget[] = workspaceWatchTargets.get(watcherKey) ?? [],
): void {
  const workspaceDir = workspaceWatchOwnerDirs.get(watcherKey) ?? watcherKey;
  const hadWatchTargets = watchTargets.length > 0;
  for (const watchTarget of watchTargets) {
    unsubscribeWorkspaceFromPath(watcherKey, watchTarget);
  }
  workspaceWatchTargets.delete(watcherKey);
  workspaceWatchOwnerDirs.delete(watcherKey);
  workspaceWatchTargetCache.delete(watcherKey);
  workspaceWatchLastEnsuredAt.delete(watcherKey);
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

export function ensureSkillsWatcher(params: {
  workspaceDir: string;
  executionSkillsDir?: string;
  config?: OpenClawConfig;
  agentId?: string;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
}) {
  const workspaceDir = params.workspaceDir.trim();
  if (!workspaceDir) {
    return;
  }
  const watcherKey = createWorkshopWatcherKey(workspaceDir, params);
  workspaceWatchOwnerDirs.set(watcherKey, workspaceDir);
  const now = Date.now();
  const watchEnabled = params.config?.skills?.load?.watch !== false;
  const previousTargets = workspaceWatchTargets.get(watcherKey) ?? [];

  if (!watchEnabled) {
    disposeWorkspaceWatchState(watcherKey, previousTargets);
    evictIdleWorkspaceWatchStates(now);
    return;
  }

  workspaceWatchLastEnsuredAt.set(watcherKey, now);
  const watchTargets = resolveWatchTargets(
    workspaceDir,
    params.config,
    params.agentId,
    params.executionSkillsDir,
    watcherKey,
    params.pluginMetadataSnapshot,
  );
  const targetsUnchanged = sameWatchTargets(previousTargets, watchTargets);
  const watcherDepthsCoverTargets = watchTargets.every(
    (watchTarget) => (pathWatchers.get(watchTarget.path)?.depth ?? -1) >= watchTarget.depth,
  );
  if (targetsUnchanged && watcherDepthsCoverTargets) {
    evictIdleWorkspaceWatchStates(now);
    return;
  }
  const watchTargetsChanged = previousTargets.length > 0 && !targetsUnchanged;

  const nextTargetKeys = new Set(watchTargets.map((target) => target.path));
  for (const watchTarget of previousTargets) {
    if (!nextTargetKeys.has(watchTarget.path)) {
      unsubscribeWorkspaceFromPath(watcherKey, watchTarget);
    }
  }
  for (const watchTarget of watchTargets) {
    subscribeWorkspaceToPath(watcherKey, watchTarget);
  }
  workspaceWatchTargets.set(watcherKey, watchTargets);

  if (watchTargetsChanged) {
    bumpSkillsSnapshotVersion({
      workspaceDir,
      reason: "watch-targets",
      changedPath: watchTargets.map((target) => target.path).join("|"),
    });
  }
  evictIdleWorkspaceWatchStates(now);
}

export async function closeSkillsWatchers(resetState = false): Promise<void> {
  if (resetState) {
    resetSkillsRefreshStateForTest();
  }
  const active = Array.from(pathWatchers.values());
  pathWatchers.clear();
  workspaceWatchTargets.clear();
  workspaceWatchOwnerDirs.clear();
  workspaceWatchTargetCache.clear();
  workspaceWatchLastEnsuredAt.clear();
  await Promise.all(active.map(teardownSkillsPathWatcher));
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.skillsRefreshTestApi")] = {
    resetSkillsRefreshForTest: () => closeSkillsWatchers(true),
  };
}
