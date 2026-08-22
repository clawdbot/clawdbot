/** Lifecycle-owned generation for managed macOS Codex desktop artifacts. */
import { existsSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
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
const REARM_DELAY_MS = 100;
const DESKTOP_GENERATION_STATE = Symbol.for("openclaw.codexDesktopGenerationState");

type GenerationOwner = ReturnType<typeof createCodexDesktopGenerationOwner>;
type WatchFactory = (
  watchedPath: string,
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
  armEpoch?: number;
  rearmTimer?: NodeJS.Timeout;
  context?: OpenClawPluginServiceContext;
  readFingerprint?: () => Promise<string>;
  resolveWatchPaths?: () => string[];
  pathExists?: (watchedPath: string) => boolean;
  watchPath?: WatchFactory;
};

function state(): DesktopGenerationState {
  // SAFETY: this process-global symbol is owned exclusively by this module.
  const globalState = globalThis as typeof globalThis & {
    [DESKTOP_GENERATION_STATE]?: DesktopGenerationState;
  };
  return (globalState[DESKTOP_GENERATION_STATE] ??= {});
}

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
    watchPath: (watchedPath, listener) => watch(watchedPath, listener),
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
      if (current.rearmTimer) {
        clearTimeout(current.rearmTimer);
        current.rearmTimer = undefined;
      }
      closeWatchers(current);
    },
  };
}

function armWatchers(current: DesktopGenerationState): void {
  const owner = current.owner;
  if (!owner || current.watchers) {
    return;
  }
  const armEpoch = (current.armEpoch ?? 0) + 1;
  current.armEpoch = armEpoch;
  const watchers = new Set<FSWatcher>();
  current.watchers = watchers;
  const candidateNames = new Set<string>(
    resolveMacOSDesktopCodexAppPathCandidates("darwin").map((candidate) => candidate.appName),
  );
  for (const watchedPath of current.resolveWatchPaths?.() ?? []) {
    if (!current.pathExists?.(watchedPath)) {
      continue;
    }
    try {
      const watcher = current.watchPath?.(watchedPath, (_eventType, filename) => {
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
      });
      if (!watcher) {
        continue;
      }
      watchers.add(watcher);
      watcher.on("error", (error) => {
        if (!isCurrentArm(current, owner, watchers, armEpoch)) {
          return;
        }
        current.context?.serviceHealth?.reportFailure(error);
        current.context?.logger.warn(`codex desktop generation watcher failed: ${String(error)}`);
        owner.markDirty();
        scheduleRearm(current, owner);
      });
    } catch (error) {
      current.context?.serviceHealth?.reportFailure(error);
      current.context?.logger.warn(`codex desktop generation watcher failed: ${String(error)}`);
      owner.markDirty();
      scheduleRearm(current, owner);
    }
  }
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
    clearTimeout(current.rearmTimer);
  }
  current.rearmTimer = setTimeout(() => {
    current.rearmTimer = undefined;
    if (current.owner !== owner) {
      return;
    }
    closeWatchers(current);
    armWatchers(current);
    owner.markDirty();
    refreshGeneration(current, owner, owner.wait());
  }, REARM_DELAY_MS);
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
      if (current.owner === owner) {
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
