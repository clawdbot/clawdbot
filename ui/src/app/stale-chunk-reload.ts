// Stale hashed-chunk recovery for lazy routes and the entry stylesheet.
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
import { t } from "../i18n/index.ts";
import { getSafeSessionStorage } from "../local-storage.ts";
import { canReloadControlUiDocument } from "./document-reload-guard.ts";

const RELOAD_GUARD_STORAGE_KEY = "openclaw.controlUi.staleChunkReloadBuildId";
// Bounds document probes across rapid re-renders of the same error state.
const ATTEMPT_COOLDOWN_MS = 5_000;
// Keep timeout below the cooldown so a timed-out retry re-render cannot start
// another probe immediately while the gateway is still unreachable.
const DOCUMENT_PROBE_TIMEOUT_MS = 3_000;

// WebKit, Chromium, Firefox, and Vite's preload helper use these four phrases.
const MODULE_IMPORT_ERROR_PATTERN =
  /importing a module script failed|failed to fetch dynamically imported module|error loading dynamically imported module|unable to preload css/i;

type StaleChunkReloadDeps = {
  now?: () => number;
  buildId?: string;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  reload?: () => void;
};

type MissingStylesheetRecoveryDeps = {
  isCssApplied?: () => boolean;
  schedule?: () => Promise<boolean>;
  retry?: () => Promise<boolean>;
};

type RecoveryState = [attemptsByBuild: Map<string, number>, pendingBuildId: string | null];

const recoveryByStorage = new WeakMap<object, RecoveryState>();
const unavailableStorage = {};
// A shared probe can release automatic and manual recovery in the same microtask.
// Admit one navigation before either path can replace the guard or reload.
let inFlightDocumentProbe: { buildId?: string; promise: Promise<boolean> } | null = null;

export function isStaleChunkImportError(error: unknown): boolean {
  return error instanceof Error && MODULE_IMPORT_ERROR_PATTERN.test(error.message);
}

export function reloadControlUiDocument(): void {
  const url = new URL(window.location.href);
  // The pre-app mount recovery strips this one-shot cache buster before bootstrap.
  url.searchParams.set("openclaw_mount_recovery", String(Date.now()));
  window.location.replace(url.href);
}

function probeControlUiDocument(buildId?: string): Promise<boolean> {
  if (inFlightDocumentProbe) {
    return inFlightDocumentProbe.promise;
  }
  const probe = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOCUMENT_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(window.location.href, {
        method: "HEAD",
        cache: "no-store",
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  })();
  const settledProbe = probe.finally(() => {
    if (inFlightDocumentProbe?.promise === settledProbe) {
      inFlightDocumentProbe = null;
    }
  });
  inFlightDocumentProbe = { buildId, promise: settledProbe };
  return settledProbe;
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
  if (!canReloadControlUiDocument()) {
    return false;
  }
  const storage = deps.storage === undefined ? getSafeSessionStorage() : deps.storage;
  const buildId = deps.buildId ?? CONTROL_UI_BUILD_INFO.buildId;
  // One automatic reload per build id: if the reloaded document still fails
  // with the same build, the build itself is broken and reloading cannot help.
  // A genuinely newer deployment ships a new build id and may recover again.
  try {
    if (storage?.getItem(RELOAD_GUARD_STORAGE_KEY) === buildId) {
      return false;
    }
  } catch {
    // Unreadable storage follows the same safe path as unavailable storage.
  }
  const now = deps.now?.() ?? Date.now();
  const storageIdentity = storage ?? unavailableStorage;
  const recovery = recoveryByStorage.get(storageIdentity) ?? [new Map<string, number>(), buildId];
  const attemptsByBuild = recovery[0];
  for (const [attemptedBuildId, attemptedAt] of attemptsByBuild) {
    if (now - attemptedAt >= ATTEMPT_COOLDOWN_MS) {
      attemptsByBuild.delete(attemptedBuildId);
    }
  }
  if (attemptsByBuild.has(buildId)) {
    return false;
  }
  attemptsByBuild.set(buildId, now);
  recovery[1] = buildId;
  recoveryByStorage.set(storageIdentity, recovery);
  // A newer build cannot inherit the failed probe started for an older build.
  const joinedOlderBuildProbe = Boolean(
    inFlightDocumentProbe && inFlightDocumentProbe.buildId !== buildId,
  );
  if (
    !(await probeControlUiDocument(buildId)) &&
    (!joinedOlderBuildProbe || !(await probeControlUiDocument(buildId)))
  ) {
    return false;
  }
  // A reload resets the in-memory state, so without a persisted guard a broken
  // build would reload forever. When storage is unavailable or rejects the
  // write, leave recovery to the manual Retry path instead of reloading.
  const reload = deps.reload ?? reloadControlUiDocument;
  if (
    !canReloadControlUiDocument() ||
    recovery[1] !== buildId ||
    !persistGuardBuildId(storage, buildId)
  ) {
    return false;
  }
  recovery[1] = null;
  reload();
  return true;
}

// A restarting gateway is the common case behind this banner: the stale chunk
// exists precisely because the gateway was just updated. Give the restart time
// to finish rather than declining the reload on the first failed probe.
const REACHABLE_WAIT_TIMEOUT_MS = 30_000;
const REACHABLE_WAIT_INTERVAL_MS = 1_000;

/**
 * Keeps the advertised bound local instead of trusting the probe to time out:
 * the default probe aborts itself, but a caller-supplied one need not, and a
 * probe that never settles would strand the caller's pending UI forever.
 */
async function probeWithinDeadline(
  probe: () => Promise<boolean>,
  remainingMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), remainingMs);
  });
  try {
    return await Promise.race([probe(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * User-initiated retry that survives the restart which caused the stale chunk:
 * poll until the gateway answers, then reload if the caller still owns recovery.
 * Unreachable or retired requests keep the current document instead of navigating
 * into a fatal error page or discarding a newer action.
 */
export async function retryStaleChunkReloadWhenReachable(
  deps: StaleChunkReloadDeps & {
    timeoutMs?: number;
    intervalMs?: number;
    probe?: () => Promise<boolean>;
    wait?: (ms: number) => Promise<void>;
    canReload?: () => boolean;
  } = {},
): Promise<boolean> {
  if (deps.canReload?.() === false || !canReloadControlUiDocument(true)) {
    return false;
  }
  const now = deps.now ?? Date.now;
  const probe = deps.probe ?? probeControlUiDocument;
  const wait =
    deps.wait ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const intervalMs = deps.intervalMs ?? REACHABLE_WAIT_INTERVAL_MS;
  const deadline = now() + (deps.timeoutMs ?? REACHABLE_WAIT_TIMEOUT_MS);
  for (let attempt = 0; ; attempt += 1) {
    const remaining = deadline - now();
    // The interval wait can carry the loop past the deadline, so re-check here:
    // only the first attempt may probe from outside the window.
    if (attempt > 0 && remaining <= 0) {
      return false;
    }
    // The first attempt always probes, so timeoutMs: 0 means "single shot"
    // rather than "never ask"; the probe's own abort bounds that case.
    const reachable = remaining > 0 ? await probeWithinDeadline(probe, remaining) : await probe();
    if (reachable) {
      // The probe may outlive Close, a new request, or a failed replay-state write.
      if (deps.canReload?.() === false || !canReloadControlUiDocument(true)) {
        return false;
      }
      const storage = deps.storage === undefined ? getSafeSessionStorage() : deps.storage;
      const storageIdentity = storage ?? unavailableStorage;
      const reload = deps.reload ?? reloadControlUiDocument;
      const recovery = recoveryByStorage.get(storageIdentity) ?? [
        new Map<string, number>(),
        CONTROL_UI_BUILD_INFO.buildId,
      ];
      recoveryByStorage.set(storageIdentity, recovery);
      const buildId = recovery[1];
      if (buildId === null) {
        return false;
      }
      recovery[1] = null;
      persistGuardBuildId(storage, buildId);
      reload();
      return true;
    }
    if (now() >= deadline) {
      return false;
    }
    await wait(intervalMs);
  }
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

export function installMissingStylesheetRecovery(
  deps: MissingStylesheetRecoveryDeps = {},
): () => void {
  const isCssApplied =
    deps.isCssApplied ??
    (() =>
      getComputedStyle(document.documentElement).getPropertyValue("--openclaw-css-ok").trim() ===
      "1");
  const schedule = deps.schedule ?? scheduleStaleChunkReload;
  // Single-shot (timeoutMs: 0) keeps the stylesheet banner's existing
  // behavior; only the lazy-route button waits out a restart.
  const retry = deps.retry ?? (() => retryStaleChunkReloadWhenReachable({ timeoutMs: 0 }));
  let detected = false;
  let uninstalled = false;
  let banner: HTMLDivElement | null = null;

  const removeListeners = () => {
    window.removeEventListener("load", checkStylesheet);
    window.removeEventListener("error", onResourceError, true);
  };

  const showBanner = () => {
    if (uninstalled || banner) {
      return;
    }
    banner = document.createElement("div");
    banner.role = "alert";
    // All styles are inline because the entry stylesheet is broken by definition.
    banner.style.cssText =
      "position:fixed;inset:0 0 auto;z-index:2147483647;padding:12px;text-align:center;background:#1f2937;color:#fff;font:14px system-ui";
    const reloadButton = document.createElement("button");
    reloadButton.textContent = t("common.reload");
    reloadButton.addEventListener("click", () => void retry());
    banner.append(t("lazyView.stylesFailed"), " ", reloadButton);
    document.body.append(banner);
  };

  const detectMissingStylesheet = async () => {
    if (detected || uninstalled) {
      return;
    }
    detected = true;
    removeListeners();
    const reloaded = await schedule();
    if (!reloaded) {
      showBanner();
    }
  };

  function checkStylesheet() {
    if (isCssApplied()) {
      removeListeners();
      return;
    }
    void detectMissingStylesheet();
  }

  function onResourceError(event: Event) {
    const resource = event.target;
    if (!(resource instanceof HTMLLinkElement) || !resource.relList.contains("stylesheet")) {
      return;
    }
    // Resource errors do not bubble, so capture is required. This can miss an
    // error fired before module evaluation; the load-time sentinel is authoritative.
    void detectMissingStylesheet();
  }

  window.addEventListener("error", onResourceError, true);
  if (document.readyState === "complete") {
    checkStylesheet();
  } else {
    window.addEventListener("load", checkStylesheet, { once: true });
  }

  return () => {
    uninstalled = true;
    removeListeners();
    banner?.remove();
    banner = null;
  };
}
