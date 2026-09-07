/** Lifecycle-owned generation for managed macOS Codex desktop artifacts. */
import { existsSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { defineCodexBuildState } from "../build-state.js";
import { resolveMacOSDesktopCodexAppPathCandidates } from "./desktop-app-paths.js";
import {
  readMacOSDesktopGenerationFingerprint,
  resolveMacOSDesktopGenerationWatchPaths,
} from "./desktop-generation-fingerprint.js";
import {
  createCodexDesktopGenerationOwner,
  type CodexDesktopGeneration,
} from "./desktop-generation-owner.js";

const APPLICATIONS_PATH = "/Applications";
const REARM_INITIAL_DELAY_MS = 100;
const REARM_MAX_DELAY_MS = 30_000;

type GenerationOwner = ReturnType<typeof createCodexDesktopGenerationOwner>;
type WatchFactory = (
  watchedPath: string,
  options: { recursive: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => FSWatcher;
type DesktopGenerationRuntime = {
  platform: NodeJS.Platform;
  readFingerprint: () => Promise<string>;
  resolveWatchPaths: () => string[];
  pathExists: (watchedPath: string) => boolean;
  watchPath: WatchFactory;
};
type DesktopGenerationState = {
  owner?: GenerationOwner;
  lastGeneration?: CodexDesktopGeneration;
  watchers?: Set<FSWatcher>;
  watchHealthy?: boolean;
  armEpoch?: number;
  rearmTimer?: NodeJS.Timeout;
  rearmDelayMs?: number;
  context?: OpenClawPluginServiceContext;
  readFingerprint?: () => Promise<string>;
  resolveWatchPaths?: () => string[];
  pathExists?: (watchedPath: string) => boolean;
  watchPath?: WatchFactory;
};

const state = defineCodexBuildState(
  "openclaw.codexDesktopGenerationState",
  (): DesktopGenerationState => ({}),
);

export function waitForCodexDesktopGeneration(): Promise<CodexDesktopGeneration | undefined> {
  return state().owner?.wait() ?? Promise.resolve(undefined);
}

export function isCodexDesktopGenerationCurrent(
  generation: CodexDesktopGeneration | undefined,
): boolean {
  return state().owner?.isCurrent(generation) ?? false;
}

export function createCodexDesktopGenerationService(
  params: {
    onGenerationChange: (generation: CodexDesktopGeneration) => void;
  },
  runtime: DesktopGenerationRuntime = {
    platform: process.platform,
    readFingerprint: readMacOSDesktopGenerationFingerprint,
    resolveWatchPaths: resolveMacOSDesktopGenerationWatchPaths,
    pathExists: existsSync,
    watchPath: (watchedPath, options, listener) => watch(watchedPath, options, listener),
  },
): OpenClawPluginService {
  return {
    id: "codex-desktop-generation",
    async start(ctx) {
      if (runtime.platform !== "darwin") {
        return;
      }
      const current = state();
      current.context = ctx;
      current.readFingerprint = runtime.readFingerprint;
      current.resolveWatchPaths = runtime.resolveWatchPaths;
      current.pathExists = runtime.pathExists;
      current.watchPath = runtime.watchPath;
      current.owner = createCodexDesktopGenerationOwner({
        readFingerprint: current.readFingerprint,
        onGenerationChange: params.onGenerationChange,
        initialGeneration: current.lastGeneration,
      });
      armWatchers(current);
      refreshGeneration(current, current.owner, current.owner.refresh());
    },
    async stop() {
      const current = state();
      current.lastGeneration = current.owner?.read() ?? current.lastGeneration;
      current.owner?.stop();
      current.owner = undefined;
      current.armEpoch = (current.armEpoch ?? 0) + 1;
      current.context = undefined;
      current.readFingerprint = undefined;
      current.resolveWatchPaths = undefined;
      current.pathExists = undefined;
      current.watchPath = undefined;
      current.watchHealthy = undefined;
      current.rearmDelayMs = undefined;
      if (current.rearmTimer) {
        clearTimeout(current.rearmTimer);
        current.rearmTimer = undefined;
      }
      closeWatchers(current);
    },
  };
}

function armWatchers(current: DesktopGenerationState): boolean {
  const owner = current.owner;
  if (!owner || current.watchers) {
    return false;
  }
  const armEpoch = (current.armEpoch ?? 0) + 1;
  current.armEpoch = armEpoch;
  const watchers = new Set<FSWatcher>();
  current.watchers = watchers;
  const candidateNames = new Set<string>(
    resolveMacOSDesktopCodexAppPathCandidates("darwin").map((candidate) => candidate.appName),
  );
  let complete = true;
  for (const watchedPath of current.resolveWatchPaths?.() ?? []) {
    if (!current.pathExists?.(watchedPath)) {
      continue;
    }
    try {
      // Bundle roots need recursive invalidation: nested plugin bytes can change without
      // updating the app directory metadata that the settled fingerprint observes first.
      const watcher = current.watchPath?.(
        watchedPath,
        { recursive: watchedPath !== APPLICATIONS_PATH },
        (_eventType, filename) => {
          if (!isCurrentArm(current, owner, watchers, armEpoch)) {
            return;
          }
          if (
            watchedPath === APPLICATIONS_PATH &&
            filename &&
            !candidateNames.has(filename.toString().split(path.sep)[0] ?? "")
          ) {
            return;
          }
          owner.markDirty();
          scheduleRearm(current, owner);
        },
      );
      if (!watcher) {
        complete = false;
        reportWatcherFailure(current, owner, new Error(`Could not watch ${watchedPath}`));
        scheduleRearm(current, owner);
        continue;
      }
      watchers.add(watcher);
      watcher.on("error", (error) => {
        if (!isCurrentArm(current, owner, watchers, armEpoch)) {
          return;
        }
        reportWatcherFailure(current, owner, error);
        scheduleRearm(current, owner);
      });
    } catch (error) {
      complete = false;
      reportWatcherFailure(current, owner, error);
      scheduleRearm(current, owner);
    }
  }
  current.watchHealthy = complete;
  if (complete) {
    current.rearmDelayMs = REARM_INITIAL_DELAY_MS;
  }
  return complete;
}

function reportWatcherFailure(
  current: DesktopGenerationState,
  owner: GenerationOwner,
  error: unknown,
): void {
  if (current.watchHealthy === false) {
    return;
  }
  current.watchHealthy = false;
  owner.markDirty();
  current.context?.serviceHealth?.reportFailure(error);
  current.context?.logger.warn(`codex desktop generation watcher failed: ${String(error)}`);
}

function isCurrentArm(
  current: DesktopGenerationState,
  owner: GenerationOwner,
  watchers: Set<FSWatcher>,
  armEpoch: number,
): boolean {
  return current.owner === owner && current.watchers === watchers && current.armEpoch === armEpoch;
}

function scheduleRearm(current: DesktopGenerationState, owner: GenerationOwner): void {
  if (current.rearmTimer) {
    if (current.watchHealthy === false) {
      return;
    }
    clearTimeout(current.rearmTimer);
  }
  const delayMs =
    current.watchHealthy === false
      ? (current.rearmDelayMs ?? REARM_INITIAL_DELAY_MS)
      : REARM_INITIAL_DELAY_MS;
  if (current.watchHealthy === false) {
    current.rearmDelayMs = Math.min(delayMs * 2, REARM_MAX_DELAY_MS);
  }
  current.rearmTimer = setTimeout(() => {
    current.rearmTimer = undefined;
    if (current.owner !== owner) {
      return;
    }
    const wasUnhealthy = current.watchHealthy === false;
    closeWatchers(current);
    if (!armWatchers(current) || wasUnhealthy) {
      owner.markDirty();
    }
    refreshGeneration(current, owner, owner.wait());
  }, delayMs);
  current.rearmTimer.unref();
}

function logRefreshFailure(current: DesktopGenerationState, owner: GenerationOwner) {
  return (error: unknown) => {
    if (current.owner !== owner) {
      return;
    }
    current.context?.serviceHealth?.reportFailure(error);
    current.context?.logger.warn(`codex desktop generation refresh failed: ${String(error)}`);
  };
}

function refreshGeneration(
  current: DesktopGenerationState,
  owner: GenerationOwner,
  refresh: Promise<CodexDesktopGeneration | undefined>,
): void {
  void refresh
    .then(() => {
      if (current.owner === owner && current.watchHealthy) {
        current.context?.serviceHealth?.clearFailure();
      }
    })
    .catch(logRefreshFailure(current, owner));
}

function closeWatchers(current: DesktopGenerationState): void {
  const watchers = current.watchers;
  current.watchers = undefined;
  for (const watcher of watchers ?? []) {
    watcher.close();
  }
}
