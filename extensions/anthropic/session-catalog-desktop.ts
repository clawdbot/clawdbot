import fs from "node:fs/promises";
import path from "node:path";
import type { SessionCatalogPullRequestSummary } from "openclaw/plugin-sdk/session-catalog";
import {
  asPositiveSafeInteger as pullRequestNumber,
  isRecord,
  normalizeBoundedOptionalString as readBoundedString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { readClaudeDesktopCustomGroups } from "./claude-desktop-groups.js";
import {
  childDirectories,
  desktopSessionsDir,
  readJsonFile,
  setBoundedCache,
} from "./session-catalog-scan.js";
import {
  createDirtyDirectoryWatch,
  type DirtyDirectoryWatch,
} from "./session-catalog-tree-watch.js";

export const MAX_STRING_LENGTH = 4096;
const MAX_SESSION_PULL_REQUESTS = 20;
const CLAUDE_DESKTOP_SCAN_TTL_MS = 60_000;

export type DesktopSessionMetadata = {
  sessionId?: unknown;
  cliSessionId?: unknown;
  cwd?: unknown;
  originCwd?: unknown;
  createdAt?: unknown;
  lastActivityAt?: unknown;
  model?: unknown;
  isArchived?: unknown;
  title?: unknown;
  customGroup?: unknown;
  prNumber?: unknown;
  prState?: unknown;
  prs?: unknown;
};

type DesktopPullRequestMetadata = {
  prNumber?: unknown;
  state?: unknown;
  dismissed?: unknown;
};

function pullRequestState(value: unknown): SessionCatalogPullRequestSummary["state"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const state = value.trim().toLowerCase();
  return state === "open" || state === "draft" || state === "merged" || state === "closed"
    ? state
    : undefined;
}

// Desktop retains historical PRs in order and marks hidden ones as dismissed;
// the top-level pair identifies the current PR whose state labels the row.
export function desktopPullRequestSummary(
  metadata: DesktopSessionMetadata,
): SessionCatalogPullRequestSummary | undefined {
  const visibleByNumber = new Map<number, SessionCatalogPullRequestSummary["state"] | undefined>();
  const dismissed = new Set<number>();
  if (Array.isArray(metadata.prs)) {
    for (const value of metadata.prs) {
      if (!isRecord(value)) {
        continue;
      }
      const entry: DesktopPullRequestMetadata = value;
      const number = pullRequestNumber(entry.prNumber);
      if (!number) {
        continue;
      }
      if (entry.dismissed === true) {
        dismissed.add(number);
        visibleByNumber.delete(number);
        continue;
      }
      if (!dismissed.has(number) && !visibleByNumber.has(number)) {
        visibleByNumber.set(number, pullRequestState(entry.state));
      }
    }
  }
  const currentNumber = pullRequestNumber(metadata.prNumber);
  let currentState = currentNumber ? visibleByNumber.get(currentNumber) : undefined;
  if (currentNumber && !dismissed.has(currentNumber)) {
    currentState = pullRequestState(metadata.prState) ?? currentState;
    // Reinsert the current PR at the tail so truncation always retains it.
    visibleByNumber.delete(currentNumber);
    visibleByNumber.set(currentNumber, currentState);
  }
  const visible = [...visibleByNumber].map(([number, state]) => ({ number, state }));
  if (visible.length === 0) {
    return undefined;
  }
  const state = currentState ?? visible.at(-1)?.state;
  if (!state) {
    return undefined;
  }
  return {
    numbers: visible.slice(-MAX_SESSION_PULL_REQUESTS).map((entry) => entry.number),
    state,
  };
}

export function parsePullRequestSummary(
  value: unknown,
): SessionCatalogPullRequestSummary | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !Array.isArray(value.numbers)) {
    throw new Error("Claude node returned an invalid pull request summary");
  }
  const numbers = value.numbers.flatMap((candidate) => {
    const number = pullRequestNumber(candidate);
    return number === undefined ? [] : [number];
  });
  const state = pullRequestState(value.state);
  if (
    numbers.length === 0 ||
    numbers.length !== value.numbers.length ||
    numbers.length > MAX_SESSION_PULL_REQUESTS ||
    new Set(numbers).size !== numbers.length ||
    !state
  ) {
    throw new Error("Claude node returned an invalid pull request summary");
  }
  return { numbers, state };
}

async function readDesktopMetadata(
  homeDir: string,
  forceRefresh?: boolean,
): Promise<{
  available: boolean;
  customGroups: Map<string, string>;
  active: Map<string, DesktopSessionMetadata>;
  archived: Set<string>;
}> {
  const active = new Map<string, DesktopSessionMetadata>();
  const archived = new Set<string>();
  const customGroups = await readClaudeDesktopCustomGroups(homeDir, forceRefresh);
  for (const accountDir of await childDirectories(desktopSessionsDir(homeDir))) {
    for (const workspaceDir of await childDirectories(accountDir)) {
      let entries: string[];
      try {
        entries = await fs.readdir(workspaceDir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.startsWith("local_") || !name.endsWith(".json")) {
          continue;
        }
        const raw = await readJsonFile(path.join(workspaceDir, name));
        if (!isRecord(raw)) {
          continue;
        }
        const metadata: DesktopSessionMetadata = raw;
        const cliSessionId = readBoundedString(metadata.cliSessionId, 256);
        if (!cliSessionId) {
          continue;
        }
        if (metadata.isArchived === true) {
          archived.add(cliSessionId);
          active.delete(cliSessionId);
          continue;
        }
        if (!archived.has(cliSessionId)) {
          const localSessionId = readBoundedString(metadata.sessionId, 256);
          const customGroup = localSessionId ? customGroups.get(localSessionId) : undefined;
          active.set(cliSessionId, customGroup ? { ...metadata, customGroup } : metadata);
        }
      }
    }
  }
  return { available: true, active, archived, customGroups };
}

export type DesktopOverlay = Awaited<ReturnType<typeof readDesktopMetadata>>;
type DesktopOverlayCacheEntry = {
  watch?: DirtyDirectoryWatch;
  refreshedAt: number;
  refreshing: boolean;
  overlay: Promise<DesktopOverlay>;
};
const desktopOverlays = new Map<string, DesktopOverlayCacheEntry>();
export const emptyDesktopOverlay: DesktopOverlay = {
  available: false,
  active: new Map(),
  archived: new Set(),
  customGroups: new Map(),
};

export async function readDesktopOverlay(
  homeDir: string,
  forceRefresh?: boolean,
): Promise<DesktopOverlay> {
  const entry = desktopOverlays.get(homeDir);
  if (entry?.refreshing) {
    if (!forceRefresh) {
      return entry.overlay;
    }
    await entry.overlay;
    return readDesktopOverlay(homeDir, forceRefresh);
  }
  const dirty = entry?.watch?.takeDirty();
  // Groups live in Local Storage outside this watch. Keep the 60s Desktop refresh even
  // with clean session metadata; it must not invalidate the independent CLI scan.
  if (
    !forceRefresh &&
    entry &&
    entry.refreshedAt + CLAUDE_DESKTOP_SCAN_TTL_MS > Date.now() &&
    dirty !== "all" &&
    !(dirty instanceof Set && dirty.size > 0)
  ) {
    setBoundedCache(desktopOverlays, homeDir, entry, 8, (evicted) => evicted.watch?.close());
    return entry.overlay;
  }
  const watch = entry?.watch ?? createDirtyDirectoryWatch(desktopSessionsDir(homeDir));
  const current: DesktopOverlayCacheEntry = {
    watch,
    refreshedAt: Date.now(),
    refreshing: true,
    overlay: Promise.resolve(emptyDesktopOverlay),
  };
  current.overlay = (async () => {
    const stat = await fs.stat(desktopSessionsDir(homeDir)).catch(() => undefined);
    if (!stat?.isDirectory()) {
      // An absent Desktop store is rechecked on the 60s overlay TTL, never on each CLI poll.
      watch.close();
      current.watch = undefined;
      return emptyDesktopOverlay;
    }
    return readDesktopMetadata(homeDir, forceRefresh);
  })().finally(() => {
    current.refreshing = false;
  });
  setBoundedCache(desktopOverlays, homeDir, current, 8, (evicted) => evicted.watch?.close());
  return current.overlay;
}
