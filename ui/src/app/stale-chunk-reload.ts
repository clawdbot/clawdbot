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

const RELOAD_GUARD_STORAGE_KEY = "openclaw.controlUi.staleChunkReloadBuildId";
// Bounds document probes across rapid re-renders of the same error state.
const ATTEMPT_COOLDOWN_MS = 5_000;
// Keep timeout below the cooldown so a timed-out retry re-render cannot start
// another probe immediately while the gateway is still unreachable.
const DOCUMENT_PROBE_TIMEOUT_MS = 3_000;

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
  reload?: () => void;
};

type MissingStylesheetRecoveryDeps = {
  isCssApplied?: () => boolean;
  schedule?: () => Promise<boolean>;
  retry?: () => Promise<boolean>;
};

const lastAttemptAtByStorage = new WeakMap<object, number>();
let lastAttemptWithoutStorage: number | null = null;
let inFlightDocumentProbe: Promise<boolean> | null = null;

export function isStaleChunkImportError(error: unknown): boolean {
  return (
    error instanceof Error &&
    MODULE_IMPORT_ERROR_PATTERNS.some((pattern) => pattern.test(error.message))
  );
}

function reloadControlUiDocument(): void {
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

function probeControlUiDocument(): Promise<boolean> {
  if (inFlightDocumentProbe) {
    return inFlightDocumentProbe;
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
    if (inFlightDocumentProbe === settledProbe) {
      inFlightDocumentProbe = null;
    }
  });
  inFlightDocumentProbe = settledProbe;
  return settledProbe;
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
  const storage = deps.storage === undefined ? sessionStorageOrNull() : deps.storage;
  const lastAttemptAt = storage
    ? (lastAttemptAtByStorage.get(storage) ?? null)
    : lastAttemptWithoutStorage;
  if (lastAttemptAt !== null && now - lastAttemptAt < ATTEMPT_COOLDOWN_MS) {
    return false;
  }
  if (storage) {
    lastAttemptAtByStorage.set(storage, now);
  } else {
    lastAttemptWithoutStorage = now;
  }
  const buildId = deps.buildId ?? CONTROL_UI_BUILD_INFO.buildId;
  // One automatic reload per build id: if the reloaded document still fails
  // with the same build, the build itself is broken and reloading cannot help.
  // A genuinely newer deployment ships a new build id and may recover again.
  if (readGuardBuildId(storage) === buildId) {
    return false;
  }
  if (!(await probeControlUiDocument())) {
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
 * poll until the gateway answers, then reload. Returns false only when it stays
 * unreachable for the whole window, so callers keep the recoverable panel error
 * instead of navigating into a fatal error page.
 */
export async function retryStaleChunkReloadWhenReachable(
  deps: StaleChunkReloadDeps & {
    timeoutMs?: number;
    intervalMs?: number;
    probe?: () => Promise<boolean>;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
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
      (deps.reload ?? reloadControlUiDocument)();
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
    banner.setAttribute("role", "alert");
    // All styles are inline because the entry stylesheet is broken by definition.
    Object.assign(banner.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "12px",
      padding: "12px 16px",
      background: "#1f2937",
      color: "#ffffff",
      fontFamily: "system-ui, sans-serif",
      fontSize: "14px",
    });
    const message = document.createElement("span");
    // Intentional English: this failure surface mirrors the inline index.html fallback.
    message.textContent = "Styles failed to load, so the page may look broken.";
    const reloadButton = document.createElement("button");
    reloadButton.type = "button";
    reloadButton.textContent = "Reload";
    Object.assign(reloadButton.style, {
      border: "0",
      borderRadius: "4px",
      padding: "6px 12px",
      background: "#ffffff",
      color: "#111827",
      cursor: "pointer",
      font: "inherit",
    });
    reloadButton.addEventListener("click", () => void retry());
    banner.append(message, reloadButton);
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
