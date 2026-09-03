/**
 * File chooser, dialog, and download helpers for Playwright-backed browser
 * tools.
 */
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { Page } from "playwright-core";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS } from "./constants.js";
import type { BrowserDownloadResult } from "./download-types.js";
import { resolveStrictExistingUploadPaths } from "./paths.js";
import { createDownloadCaptureForPage } from "./pw-download-capture.js";
import {
  armObservedDialogResponseOnPage,
  ensurePageState,
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
  awaitActionWithAbort,
  createAbortPromiseWithListener,
  type NavigationTargetOptions,
} from "./pw-tools-core.interactions.navigation.js";
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

type ActiveUpload = {
  controller: AbortController;
  settled: Promise<void>;
};

const activeUploads = new WeakMap<Page, ActiveUpload>();

function createExplicitDownloadCapture(params: {
  page: Page;
  state: ReturnType<typeof ensurePageState>;
  timeoutMs: number;
  outPath?: string;
  rootDir?: string;
  signal?: AbortSignal;
}) {
  params.state.armIdDownload = bumpDownloadArmId();
  const armId = params.state.armIdDownload;
  return createDownloadCaptureForPage(params.page, params.state, params.timeoutMs, {
    mode: "explicit",
    outputPath: params.outPath,
    outputRoot: params.rootDir,
    signal: params.signal,
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

type UploadOptions = NavigationTargetOptions & {
  ref?: string;
  paths?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
};

async function runFileUpload(opts: UploadOptions): Promise<void> {
  opts.signal?.throwIfAborted();
  const atomic = opts.ref !== undefined;
  const armId = bumpUploadArmId();
  const timeout = normalizeTimeoutMs(opts.timeoutMs, DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS);
  const controller = new AbortController();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, controller.signal])
    : controller.signal;
  const { abortPromise, cleanup } = createAbortPromiseWithListener(signal);
  const armed = createDeferred<void>();
  let started = false;
  let deadline = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startDeadline = () => {
    deadline = Date.now() + timeout;
    timer = setTimeout(
      () =>
        controller.abort(new Error(`Timeout ${timeout}ms exceeded while completing file upload`)),
      timeout,
    );
  };
  if (atomic) {
    startDeadline();
  }
  const completion = (async () => {
    const page = await awaitActionWithAbort(getPageForTargetId(opts), abortPromise);
    signal.throwIfAborted();
    const state = ensurePageState(page);
    // Page lookup may finish out of order. Only a newer request can replace
    // this page's owner; unrelated tabs share no chooser or cleanup queue.
    if (state.armIdUpload > armId) {
      throw new Error("File upload was superseded by another waiter");
    }
    state.armIdUpload = armId;
    const previous = activeUploads.get(page);
    const execution = Promise.resolve().then(async () => {
      // A cancelled queued caller may return early, but its successor must
      // still join every older native action before installing a new waiter.
      await previous?.settled;
      signal.throwIfAborted();
      started = true;
      if (!atomic) {
        startDeadline();
      }
      const chooser = page.waitForEvent("filechooser", { timeout: 0, signal });
      void chooser.catch(() => {});
      armed.resolve();
      try {
        if (atomic) {
          await clickViaPlaywright({
            ...opts,
            ref: opts.ref!,
            timeoutMs: Math.max(1, deadline - Date.now()),
            resolvedPage: page,
            signal,
          });
        }
        const fileChooser = await chooser;
        signal.throwIfAborted();
        let paths = opts.paths ?? [];
        if (!atomic) {
          const resolved = await awaitActionWithAbort(
            resolveStrictExistingUploadPaths({ requestedPaths: paths }),
            abortPromise,
          );
          signal.throwIfAborted();
          if (!paths.length || !resolved.ok) {
            await dismissFileChooser(page);
            return;
          }
          paths = resolved.paths;
        }
        await setFileChooserFilesViaPlaywright({
          ...opts,
          page,
          fileChooser,
          paths,
          timeoutMs: Math.max(1, deadline - Date.now()),
          signal,
        });
        signal.throwIfAborted();
      } catch (error) {
        controller.abort(error);
        if (
          error instanceof Error &&
          error.name === "AbortError" &&
          error.cause === signal.reason
        ) {
          signal.throwIfAborted();
        }
        throw error;
      } finally {
        await chooser.catch(() => {});
      }
    });
    const active = {
      controller,
      settled: execution.then(
        () => {},
        () => {},
      ),
    };
    activeUploads.set(page, active);
    previous?.controller.abort(new Error("File upload was superseded by another waiter"));
    try {
      await execution;
    } finally {
      if (activeUploads.get(page) === active) {
        activeUploads.delete(page);
      }
    }
  })().finally(() => {
    clearTimeout(timer);
    cleanup();
  });
  // Passive arming intentionally outlives this call; its errors are contained.
  void completion.catch(() => {});
  try {
    await awaitActionWithAbort(
      atomic ? completion : Promise.race([armed.promise, completion]),
      abortPromise,
    );
  } catch (error) {
    if (atomic && started) {
      await completion;
    }
    throw error;
  }
}

/** Arms the next page file chooser and fills it with strict existing paths. */
export async function armFileUploadViaPlaywright(
  opts: Omit<UploadOptions, "ref" | "signal">,
): Promise<void> {
  await runFileUpload(opts);
}

/** Clicks a ref and completes its file chooser as one request-owned operation. */
export async function uploadViaPlaywright(
  opts: UploadOptions & { ref: string; paths: string[] },
): Promise<void> {
  await runFileUpload(opts);
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
  signal?: AbortSignal;
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
    signal: opts.signal,
  });
  return await capture.promise;
}

/** Clicks an element ref and saves the download triggered by that click. */
export async function downloadViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
  path: string;
  rootDir?: string;
  signal?: AbortSignal;
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
    signal: opts.signal,
  });
  void capture.promise.catch(() => {});
  try {
    const locator = refLocator(page, ref);
    await locator.click({ timeout, signal: opts.signal });
  } catch (err) {
    capture.cancel();
    throw opts.signal?.aborted && opts.signal.reason instanceof Error
      ? opts.signal.reason
      : toAIFriendlyError(err, ref);
  }
  return await capture.promise;
}
