import os from "node:os";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import { resolvePluginSkillDirs } from "./plugin-skills.js";
import {
  bumpSkillsSnapshotVersion,
  resetSkillsRefreshStateForTest,
  setSkillsChangeListenerErrorHandler,
} from "./refresh-state.js";
export {
  bumpSkillsSnapshotVersion,
  getSkillsSnapshotVersion,
  registerSkillsChangeListener,
  shouldRefreshSnapshotForVersion,
  type SkillsChangeEvent,
} from "./refresh-state.js";

type SkillsPathWatchState = {
  watcher: FSWatcher;
  debounceMs: number;
  timer?: ReturnType<typeof setTimeout>;
  pendingPath?: string;
  readonly subscribers: Set<string>;
};

const log = createSubsystemLogger("gateway/skills");
// One watcher per unique watched directory. Agent workspaces that include the
// same shared skill root (the global skills dir, the home skills dir, or a
// configured extra/plugin dir) subscribe to the same watcher instead of each
// opening its own, so open file descriptors scale with distinct directories
// rather than with agent count.
const pathWatchers = new Map<string, SkillsPathWatchState>();
// Watch targets each workspace is currently subscribed to, used to reconcile
// subscriptions and to detect watch-target changes across calls.
const workspaceWatchTargets = new Map<string, string[]>();

setSkillsChangeListenerErrorHandler((err) => {
  log.warn(`skills change listener failed: ${String(err)}`);
});

export const DEFAULT_SKILLS_WATCH_IGNORED: RegExp[] = [
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

function resolveWatchPaths(workspaceDir: string, config?: OpenClawConfig): string[] {
  const paths: string[] = [];
  if (workspaceDir.trim()) {
    paths.push(path.join(workspaceDir, "skills"));
    paths.push(path.join(workspaceDir, ".agents", "skills"));
  }
  paths.push(path.join(CONFIG_DIR, "skills"));
  paths.push(path.join(os.homedir(), ".agents", "skills"));
  const extraDirsRaw = config?.skills?.load?.extraDirs ?? [];
  const extraDirs = extraDirsRaw
    .map((d) => normalizeOptionalString(d) ?? "")
    .filter(Boolean)
    .map((dir) => resolveUserPath(dir));
  paths.push(...extraDirs);
  const pluginSkillDirs = resolvePluginSkillDirs({ workspaceDir, config });
  paths.push(...pluginSkillDirs);
  return paths;
}

function toWatchRoot(raw: string): string {
  const normalized = raw.replaceAll("\\", "/");
  return normalized.replace(/\/+$/, "") || normalized;
}

function resolveWatchTargets(workspaceDir: string, config?: OpenClawConfig): string[] {
  const targets = new Set<string>();
  for (const root of resolveWatchPaths(workspaceDir, config)) {
    targets.add(toWatchRoot(root));
  }
  return Array.from(targets).toSorted();
}

export function shouldIgnoreSkillsWatchPath(
  watchPath: string,
  stats?: { isDirectory?: () => boolean },
): boolean {
  if (DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(watchPath))) {
    return true;
  }
  if (stats?.isDirectory?.()) {
    return false;
  }
  if (!stats) {
    return false;
  }
  const normalized = watchPath.replaceAll("\\", "/");
  return path.posix.basename(normalized) !== "SKILL.md";
}

function resolveWatchDebounceMs(config?: OpenClawConfig): number {
  const raw = config?.skills?.load?.watchDebounceMs;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, raw) : 250;
}

// Requires resolveWatchTargets to produce a stable-order result (it returns a
// sorted array); positional comparison is intentional for hot-path efficiency.
function sameWatchTargets(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

function createSkillsPathWatcher(watchPath: string, debounceMs: number): SkillsPathWatchState {
  const watcher = chokidar.watch(watchPath, {
    ignoreInitial: true,
    // Skill discovery reads root skills, direct child skills, and one grouped skill level.
    depth: 2,
    awaitWriteFinish: {
      stabilityThreshold: debounceMs,
      pollInterval: 100,
    },
    ignored: shouldIgnoreSkillsWatchPath,
  });

  const state: SkillsPathWatchState = { watcher, debounceMs, subscribers: new Set<string>() };

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
        bumpSkillsSnapshotVersion({
          workspaceDir,
          reason: "watch",
          changedPath: pendingPath,
        });
      }
    }, debounceMs);
  };

  watcher.on("add", (p) => schedule(p));
  watcher.on("change", (p) => schedule(p));
  watcher.on("unlink", (p) => schedule(p));
  watcher.on("unlinkDir", (p) => schedule(p));
  watcher.on("error", (err) => {
    log.warn(`skills watcher error (${watchPath}): ${String(err)}`);
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
  watchPath: string,
  debounceMs: number,
): void {
  const existing = pathWatchers.get(watchPath);
  if (existing && existing.debounceMs === debounceMs) {
    existing.subscribers.add(workspaceDir);
    return;
  }
  if (existing) {
    // Debounce changed (config reload): rebuild the shared watcher while
    // preserving existing subscribers. Debounce is a gateway-global config
    // value, so all workspaces normally request the same value and this branch
    // does not fire; if it does, the most recent requested debounce wins for
    // every subscriber of the shared path (last-writer-wins).
    const next = createSkillsPathWatcher(watchPath, debounceMs);
    for (const subscriber of existing.subscribers) {
      next.subscribers.add(subscriber);
    }
    next.subscribers.add(workspaceDir);
    teardownSkillsPathWatcher(existing);
    pathWatchers.set(watchPath, next);
    return;
  }
  const state = createSkillsPathWatcher(watchPath, debounceMs);
  state.subscribers.add(workspaceDir);
  pathWatchers.set(watchPath, state);
}

function unsubscribeWorkspaceFromPath(workspaceDir: string, watchPath: string): void {
  const state = pathWatchers.get(watchPath);
  if (!state) {
    return;
  }
  state.subscribers.delete(workspaceDir);
  if (state.subscribers.size === 0) {
    teardownSkillsPathWatcher(state);
    pathWatchers.delete(watchPath);
  }
}

export function ensureSkillsWatcher(params: { workspaceDir: string; config?: OpenClawConfig }) {
  const workspaceDir = params.workspaceDir.trim();
  if (!workspaceDir) {
    return;
  }
  const watchEnabled = params.config?.skills?.load?.watch !== false;
  const debounceMs = resolveWatchDebounceMs(params.config);
  const previousTargets = workspaceWatchTargets.get(workspaceDir) ?? [];

  if (!watchEnabled) {
    if (previousTargets.length > 0) {
      for (const watchPath of previousTargets) {
        unsubscribeWorkspaceFromPath(workspaceDir, watchPath);
      }
      workspaceWatchTargets.delete(workspaceDir);
    }
    return;
  }

  const watchTargets = resolveWatchTargets(workspaceDir, params.config);
  const targetsUnchanged = sameWatchTargets(previousTargets, watchTargets);
  const debounceUnchanged = watchTargets.every(
    // undefined for paths not yet watched -> false -> fall through to subscribe.
    (watchPath) => pathWatchers.get(watchPath)?.debounceMs === debounceMs,
  );
  if (targetsUnchanged && debounceUnchanged) {
    return;
  }
  const watchTargetsChanged = previousTargets.length > 0 && !targetsUnchanged;

  const nextTargets = new Set(watchTargets);
  for (const watchPath of previousTargets) {
    if (!nextTargets.has(watchPath)) {
      unsubscribeWorkspaceFromPath(workspaceDir, watchPath);
    }
  }
  for (const watchPath of watchTargets) {
    subscribeWorkspaceToPath(workspaceDir, watchPath, debounceMs);
  }
  workspaceWatchTargets.set(workspaceDir, watchTargets);

  if (watchTargetsChanged) {
    bumpSkillsSnapshotVersion({
      workspaceDir,
      reason: "watch-targets",
      changedPath: watchTargets.join("|"),
    });
  }
}

export async function resetSkillsRefreshForTest(): Promise<void> {
  resetSkillsRefreshStateForTest();

  const active = Array.from(pathWatchers.values());
  pathWatchers.clear();
  workspaceWatchTargets.clear();
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
