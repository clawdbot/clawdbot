/**
 * File chooser, dialog, and download helpers for Playwright-backed browser
 * tools.
 */
import path from "node:path";
import type { FileChooser, Page } from "playwright-core";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS } from "./constants.js";
import type { BrowserDownloadResult } from "./download-types.js";
import type { BrowserNavigationPolicyOptions } from "./navigation-guard.js";
import { resolveStrictExistingUploadPaths } from "./paths.js";
import { createDownloadCaptureForPage } from "./pw-download-capture.js";
import {
  armObservedDialogResponseOnPage,
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  refLocator,
  respondToObservedDialogOnPage,
  restoreRoleRefsForTarget,
} from "./pw-session.js";
import {
  clickViaPlaywright,
  setFileChooserFilesViaPlaywright,
} from "./pw-tools-core.interactions.js";
import {
  bumpDownloadArmId,
  bumpUploadArmId,
  normalizeTimeoutMs,
  requireRef,
  toAIFriendlyError,
} from "./pw-tools-core.shared.js";

async function dismissFileChooser(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
}

type ActiveAtomicUpload = {
  controller: AbortController;
  settled: Promise<void>;
};

const activeAtomicUploads = new Map<string, ActiveAtomicUpload>();
const pendingUploadClaims = new Map<string, number>();

function createExplicitDownloadCapture(params: {
  page: Page;
  state: ReturnType<typeof ensurePageState>;
  timeoutMs: number;
  outPath?: string;
  rootDir?: string;
}) {
  params.state.armIdDownload = bumpDownloadArmId();
  const armId = params.state.armIdDownload;
  return createDownloadCaptureForPage(params.page, params.state, params.timeoutMs, {
    mode: "explicit",
    outputPath: params.outPath,
    outputRoot: params.rootDir,
    beforeSave: () => {
      if (params.state.armIdDownload !== armId) {
        throw new Error("Download was superseded by another waiter");
      }
    },
  });
}

function resolveImplicitDownloadRoot(): string {
  return path.join(resolvePreferredOpenClawTmpDir(), "downloads");
}

/** Arms the next page file chooser and fills it with strict existing paths. */
export async function armFileUploadViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  paths?: string[];
  timeoutMs?: number;
}): Promise<void> {
  const key = opts.cdpUrl;
  const armId = bumpUploadArmId();
  pendingUploadClaims.set(key, armId);
  try {
    const active = activeAtomicUploads.get(key);
    if (active) {
      active.controller.abort(new Error("File upload was superseded by another waiter"));
      await active.settled;
    }
    if (pendingUploadClaims.get(key) !== armId) {
      return;
    }
    const page = await getPageForTargetId(opts);
    if (pendingUploadClaims.get(key) !== armId) {
      return;
    }
    const state = ensurePageState(page);
    const timeout = normalizeTimeoutMs(opts.timeoutMs, DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS);
    state.armIdUpload = armId;

    // The waiter is intentionally detached: the tool call arms future browser UI,
    // while the later user click opens the chooser.
    void page
      .waitForEvent("filechooser", { timeout })
      .then(async (fileChooser) => {
        if (state.armIdUpload !== armId) {
          return;
        }
        if (!opts.paths?.length) {
          // Playwright removed `FileChooser.cancel()`; best-effort close the chooser instead.
          await dismissFileChooser(page);
          return;
        }
        const uploadPathsResult = await resolveStrictExistingUploadPaths({
          requestedPaths: opts.paths,
        });
        if (!uploadPathsResult.ok) {
          await dismissFileChooser(page);
          return;
        }
        await fileChooser.setFiles(uploadPathsResult.paths);
      })
      .catch(() => {
        // Ignore timeouts; the chooser may never appear.
      });
  } finally {
    if (pendingUploadClaims.get(key) === armId) {
      pendingUploadClaims.delete(key);
    }
  }
}

/** Clicks a ref and completes its file chooser as one request-owned operation. */
export async function uploadViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    ref: string;
    paths: string[];
    timeoutMs?: number;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  opts.signal?.throwIfAborted();
  // Abort cleanup disconnects the shared Playwright connection, so ownership
  // must cover every target on that connection before a successor reconnects.
  const key = opts.cdpUrl;
  const timeout = normalizeTimeoutMs(opts.timeoutMs, DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS);
  const armId = bumpUploadArmId();
  pendingUploadClaims.set(key, armId);
  const previous = activeAtomicUploads.get(key);
  const controller = new AbortController();
  const abortFromCaller = () =>
    controller.abort(opts.signal?.reason ?? new Error("File upload aborted"));
  opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (opts.signal?.aborted) {
    abortFromCaller();
  }
  const deadline = Date.now() + timeout;
  const timer = setTimeout(
    () => controller.abort(new Error(`Timeout ${timeout}ms exceeded while completing file upload`)),
    timeout,
  );
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  void aborted.catch(() => {});
  let started = false;
  let rejectQueuedAbort!: (reason: unknown) => void;
  const queuedAbort = new Promise<never>((_resolve, reject) => {
    rejectQueuedAbort = reject;
  });
  void queuedAbort.catch(() => {});
  const rejectOnAbort = () => {
    const reason = controller.signal.reason ?? new Error("File upload aborted");
    rejectAborted(reason);
    if (!started) {
      rejectQueuedAbort(reason);
    }
  };
  controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  if (controller.signal.aborted) {
    rejectOnAbort();
  }
  const execution = Promise.resolve().then(async () => {
    // Preserve the full predecessor cleanup chain even when this caller aborts
    // while queued; later owners must never skip an older in-flight click.
    await previous?.settled;
    if (activeAtomicUploads.get(key) !== active || pendingUploadClaims.get(key) !== armId) {
      throw controller.signal.reason ?? new Error("File upload was superseded by another waiter");
    }
    controller.signal.throwIfAborted();
    const page = await Promise.race([getPageForTargetId(opts), aborted]);
    if (activeAtomicUploads.get(key) !== active || pendingUploadClaims.get(key) !== armId) {
      throw controller.signal.reason ?? new Error("File upload was superseded by another waiter");
    }
    controller.signal.throwIfAborted();
    started = true;
    const state = ensurePageState(page);
    state.armIdUpload = armId;

    let resolveChooser!: (chooser: FileChooser) => void;
    let rejectChooser!: (reason: unknown) => void;
    const chooserPromise = new Promise<FileChooser>((resolve, reject) => {
      resolveChooser = resolve;
      rejectChooser = reject;
    });
    void chooserPromise.catch(() => {});
    let chooser: FileChooser | undefined;
    let chooserListening = true;
    const onChooser = (observed: FileChooser) => {
      if (chooser) {
        return;
      }
      chooser = observed;
      page.off("filechooser", onChooser);
      chooserListening = false;
      resolveChooser(observed);
    };
    page.on("filechooser", onChooser);

    let phase: "idle" | "click" | "chooser" | "validation" | "setFiles" = "idle";
    let abortCleanup: Promise<void> | undefined;
    const onAbort = () => {
      const reason = controller.signal.reason ?? new Error("File upload aborted");
      rejectChooser(reason);
      if (phase === "click" || phase === "setFiles") {
        // Playwright actions do not consume our AbortSignal. Disconnect so a
        // successor cannot start until the raw operation has actually settled.
        abortCleanup ??= forceDisconnectPlaywrightForTarget({
          cdpUrl: opts.cdpUrl,
          targetId: opts.targetId,
          ssrfPolicy: opts.ssrfPolicy,
          reason: "file upload aborted",
        }).catch(() => {});
      }
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) {
      onAbort();
    }

    try {
      controller.signal.throwIfAborted();
      phase = "click";
      await clickViaPlaywright({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        ref: opts.ref,
        timeoutMs: Math.max(1, deadline - Date.now()),
        ssrfPolicy: opts.ssrfPolicy,
        browserProxyMode: opts.browserProxyMode,
        resolvedPage: page,
      });
      phase = "chooser";
      chooser = await chooserPromise;
      if (state.armIdUpload !== armId) {
        throw new Error("File upload was superseded by another waiter");
      }
      controller.signal.throwIfAborted();
      phase = "validation";
      const uploadPathsResult = await Promise.race([
        resolveStrictExistingUploadPaths({ requestedPaths: opts.paths }),
        aborted,
      ]);
      if (!uploadPathsResult.ok) {
        throw new Error(uploadPathsResult.error);
      }
      controller.signal.throwIfAborted();
      phase = "setFiles";
      try {
        await setFileChooserFilesViaPlaywright({
          cdpUrl: opts.cdpUrl,
          targetId: opts.targetId,
          page,
          fileChooser: chooser,
          paths: uploadPathsResult.paths,
          timeoutMs: Math.max(1, deadline - Date.now()),
          ssrfPolicy: opts.ssrfPolicy,
          browserProxyMode: opts.browserProxyMode,
        });
      } finally {
        phase = "idle";
      }
      controller.signal.throwIfAborted();
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
      if (chooserListening) {
        page.off("filechooser", onChooser);
      }
      if (state.armIdUpload === armId) {
        state.armIdUpload = bumpUploadArmId();
      }
      await abortCleanup;
    }
  });

  const settled = execution.then(
    () => {},
    () => {},
  );
  const active = { controller, settled };
  activeAtomicUploads.set(key, active);
  previous?.controller.abort(new Error("File upload was superseded by another waiter"));
  void settled.then(() => {
    controller.signal.removeEventListener("abort", rejectOnAbort);
    if (activeAtomicUploads.get(key) === active) {
      activeAtomicUploads.delete(key);
    }
    if (pendingUploadClaims.get(key) === armId) {
      pendingUploadClaims.delete(key);
    }
  });
  try {
    await Promise.race([execution, queuedAbort]);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abortFromCaller);
  }
}

/** Accepts or dismisses a pending dialog, or arms the next matching dialog response. */
export async function armDialogViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  dialogId?: string;
  accept: boolean;
  promptText?: string;
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  const timeout = normalizeTimeoutMs(opts.timeoutMs, DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS);
  try {
    await respondToObservedDialogOnPage({
      page,
      accept: opts.accept,
      closedBy: "agent",
      ...(opts.dialogId !== undefined ? { dialogId: opts.dialogId } : {}),
      ...(opts.promptText !== undefined ? { promptText: opts.promptText } : {}),
    });
    return;
  } catch (err) {
    if (opts.dialogId || (err instanceof Error && !err.message.includes("No dialog is pending"))) {
      throw err;
    }
  }

  armObservedDialogResponseOnPage({
    page,
    accept: opts.accept,
    timeoutMs: timeout,
    ...(opts.promptText !== undefined ? { promptText: opts.promptText } : {}),
  });
}

/** Waits for the next page download and writes it under the configured output root. */
export async function waitForDownloadViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  path?: string;
  rootDir?: string;
  timeoutMs?: number;
}): Promise<BrowserDownloadResult> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120_000);

  const capture = createExplicitDownloadCapture({
    page,
    state,
    timeoutMs: timeout,
    outPath: opts.path,
    rootDir: opts.path?.trim() ? opts.rootDir : (opts.rootDir ?? resolveImplicitDownloadRoot()),
  });
  try {
    return await capture.promise;
  } catch (err) {
    capture.cancel();
    throw err;
  }
}

/** Clicks an element ref and saves the download triggered by that click. */
export async function downloadViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
  path: string;
  rootDir?: string;
  timeoutMs?: number;
}): Promise<BrowserDownloadResult> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120_000);

  const ref = requireRef(opts.ref);
  const outPath = opts.path?.trim() ?? "";
  if (!outPath) {
    throw new Error("path is required");
  }

  const capture = createExplicitDownloadCapture({
    page,
    state,
    timeoutMs: timeout,
    outPath,
    rootDir: opts.rootDir,
  });
  try {
    const locator = refLocator(page, ref);
    try {
      await locator.click({ timeout });
    } catch (err) {
      throw toAIFriendlyError(err, ref);
    }
    return await capture.promise;
  } catch (err) {
    capture.cancel();
    throw err;
  }
}
