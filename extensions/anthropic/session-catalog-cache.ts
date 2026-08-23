import { resolveClaudeCatalogHomeDir } from "./session-catalog-home.js";
import { readDesktopOverlay } from "./session-catalog-desktop.js";
import {
  projectsDir,
  readProjectsTreeSnapshot,
  setBoundedCache,
  type ClaudeProjectsTreeSnapshot,
} from "./session-catalog-scan.js";

const MAX_CLAUDE_SESSION_SCAN_CACHE_ENTRIES = 8;
const CLAUDE_SESSION_SCAN_HARD_TTL_MS = 5 * 60_000;
const CLAUDE_PARTIAL_SCAN_TTL_MS = 15_000;
const CLAUDE_DESKTOP_SCAN_TTL_MS = 60_000;

type ClaudeSessionScanResultLike = { complete: boolean };

type ClaudeSessionScanCacheEntry<TResult extends ClaudeSessionScanResultLike> = {
  treeStamp: string;
  hardExpiresAt: number;
  desktopStoreAvailable: boolean;
  desktopExpiresAt: number;
  result: Promise<TResult>;
};

const claudeSessionScanCache = new Map<
  string,
  ClaudeSessionScanCacheEntry<ClaudeSessionScanResultLike>
>();

export function listClaudeSessionsWithStatus<TResult extends ClaudeSessionScanResultLike>(
  scanClaudeSessions: (
    homeDir: string,
    snapshot: ClaudeProjectsTreeSnapshot,
    includeDesktop: boolean,
  ) => Promise<TResult>,
  homeDir?: string,
  options?: { forceRefresh?: boolean; configDir?: string; includeDesktop?: boolean },
): Promise<TResult>;

export async function listClaudeSessionsWithStatus(
  scanClaudeSessions: (
    homeDir: string,
    snapshot: ClaudeProjectsTreeSnapshot,
    includeDesktop: boolean,
  ) => Promise<ClaudeSessionScanResultLike>,
  homeDir = resolveClaudeCatalogHomeDir(),
  options: { forceRefresh?: boolean; configDir?: string; includeDesktop?: boolean } = {},
): Promise<ClaudeSessionScanResultLike> {
  const root = projectsDir(homeDir, options.configDir);
  const includeDesktop = options.includeDesktop !== false;
  const cacheKey = `${root}\0${includeDesktop ? "desktop" : "cli"}`;
  const [treeSnapshot, desktopStoreAvailable] = await Promise.all([
    readProjectsTreeSnapshot(root),
    includeDesktop
      ? readDesktopOverlay(homeDir).then((overlay) => overlay.available)
      : Promise.resolve(false),
  ]);
  const now = Date.now();
  const cached = claudeSessionScanCache.get(cacheKey);
  if (
    options.forceRefresh !== true &&
    cached &&
    cached.treeStamp === treeSnapshot.treeStamp &&
    cached.hardExpiresAt > now &&
    cached.desktopStoreAvailable === desktopStoreAvailable &&
    (!desktopStoreAvailable || cached.desktopExpiresAt > now)
  ) {
    setBoundedCache(
      claudeSessionScanCache,
      cacheKey,
      cached,
      MAX_CLAUDE_SESSION_SCAN_CACHE_ENTRIES,
    );
    return await cached.result;
  }
  const scan = scanClaudeSessions(homeDir, treeSnapshot, includeDesktop);
  let scanComplete = true;
  const result = scan.then((scanResult) => {
    scanComplete = scanResult.complete;
    return scanResult;
  });
  const entry = {
    treeStamp: treeSnapshot.treeStamp,
    hardExpiresAt: now + CLAUDE_SESSION_SCAN_HARD_TTL_MS,
    desktopStoreAvailable,
    desktopExpiresAt: now + CLAUDE_DESKTOP_SCAN_TTL_MS,
    result,
  };
  setBoundedCache(claudeSessionScanCache, cacheKey, entry, MAX_CLAUDE_SESSION_SCAN_CACHE_ENTRIES);
  try {
    const resolved = await result;
    if (!scanComplete && claudeSessionScanCache.get(cacheKey) === entry) {
      entry.hardExpiresAt = Date.now() + CLAUDE_PARTIAL_SCAN_TTL_MS;
    }
    return resolved;
  } catch (error) {
    if (claudeSessionScanCache.get(cacheKey) === entry) {
      claudeSessionScanCache.delete(cacheKey);
    }
    throw error;
  }
}
