// Stale hashed-chunk recovery for lazy routes.
//
// A gateway update replaces `ui/dist` in place, so a document loaded before the
// update still references the old hashed chunk URLs; the first visit to a lazy
// route after the update 404s and the dynamic import rejects ("Importing a
// module script failed"). Secure-context browsers recover through the service
// worker registered in main.ts (prior-build chunk caches + reload broadcast),
// but WKWebView (macOS/iOS apps) and plain-HTTP LAN origins never register a
// service worker, so reloading against the freshly served index.html is the
// only recovery path there.
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";

const RELOAD_GUARD_STORAGE_KEY = "openclaw.controlUi.staleChunkReloadBuildId";
// Bounds document probes across rapid re-renders of the same error state.
const ATTEMPT_COOLDOWN_MS = 5_000;

const MODULE_IMPORT_ERROR_PATTERNS = [
  /importing a module script failed/i, // WebKit
  /failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /unable to preload css/i, // Vite preload helper
];

type StaleChunkReloadDeps = {
  now?: () => number;
  buildId?: string;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  probeDocument?: () => Promise<boolean>;
  reload?: () => void;
};

let lastAttemptAt: number | null = null;

export function isStaleChunkImportError(error: unknown): boolean {
  return (
    error instanceof Error &&
    MODULE_IMPORT_ERROR_PATTERNS.some((pattern) => pattern.test(error.message))
  );
}

export function reloadControlUiDocument(): void {
  window.location.reload();
}

function sessionStorageOrNull(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return window.sessionStorage;
  } catch {
    // Storage can be disabled; recovery then stays manual via the Retry button.
    return null;
  }
}

async function probeControlUiDocument(): Promise<boolean> {
  try {
    const response = await fetch(window.location.href, { method: "HEAD", cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

function readGuardBuildId(storage: Pick<Storage, "getItem" | "setItem"> | null): string | null {
  try {
    return storage?.getItem(RELOAD_GUARD_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function persistGuardBuildId(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  buildId: string,
): boolean {
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(RELOAD_GUARD_STORAGE_KEY, buildId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reload the document so stale hashed chunks resolve against the freshly
 * served index.html. Returns whether a reload was initiated. Reloads only when
 * the gateway answers a document probe — while it is restarting, a reload
 * would replace the whole document with a navigation error (fatal inside the
 * app webviews) instead of the recoverable panel error.
 */
export async function scheduleStaleChunkReload(deps: StaleChunkReloadDeps = {}): Promise<boolean> {
  const now = deps.now?.() ?? Date.now();
  if (lastAttemptAt !== null && now - lastAttemptAt < ATTEMPT_COOLDOWN_MS) {
    return false;
  }
  lastAttemptAt = now;
  const storage = deps.storage === undefined ? sessionStorageOrNull() : deps.storage;
  const buildId = deps.buildId ?? CONTROL_UI_BUILD_INFO.buildId;
  // One automatic reload per build id: if the reloaded document still fails
  // with the same build, the build itself is broken and reloading cannot help.
  // A genuinely newer deployment ships a new build id and may recover again.
  if (readGuardBuildId(storage) === buildId) {
    return false;
  }
  if (!(await (deps.probeDocument ?? probeControlUiDocument)())) {
    return false;
  }
  // A reload resets the in-memory state, so without a persisted guard a broken
  // build would reload forever. When storage is unavailable or rejects the
  // write, leave recovery to the manual Retry path instead of reloading.
  if (!persistGuardBuildId(storage, buildId)) {
    return false;
  }
  (deps.reload ?? reloadControlUiDocument)();
  return true;
}

/**
 * User-initiated retry: bypasses the automatic-reload rate guard but keeps the
 * reachability probe — reloading against an unreachable gateway replaces the
 * recoverable panel error with a fatal navigation error in app webviews.
 */
export async function retryStaleChunkReload(deps: StaleChunkReloadDeps = {}): Promise<boolean> {
  if (!(await (deps.probeDocument ?? probeControlUiDocument)())) {
    return false;
  }
  (deps.reload ?? reloadControlUiDocument)();
  return true;
}

export function resetStaleChunkReloadStateForTest(): void {
  lastAttemptAt = null;
}

/**
 * Vite dispatches `vite:preloadError` for every lazy-import rejection,
 * including ordinary module evaluation errors — reload only for recognized
 * stale-asset failures so a plain code bug cannot trigger a reload loop.
 */
export function installStaleChunkReloadListener(
  schedule: (deps?: StaleChunkReloadDeps) => Promise<boolean> = scheduleStaleChunkReload,
): () => void {
  const onPreloadError = (event: Event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    if (!isStaleChunkImportError(payload)) {
      return;
    }
    void schedule();
  };
  window.addEventListener("vite:preloadError", onPreloadError);
  return () => window.removeEventListener("vite:preloadError", onPreloadError);
}
