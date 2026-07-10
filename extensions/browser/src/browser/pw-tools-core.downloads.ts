/**
 * File chooser, dialog, and download helpers for Playwright-backed browser
 * tools.
 */
import path from "node:path";
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
  bumpDownloadArmId,
  bumpUploadArmId,
  normalizeTimeoutMs,
  requireRef,
  toAIFriendlyError,
} from "./pw-tools-core.shared.js";

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
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  const timeout = normalizeTimeoutMs(opts.timeoutMs, DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS);

  state.armIdUpload = bumpUploadArmId();
  const armId = state.armIdUpload;

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
        try {
          await page.keyboard.press("Escape");
        } catch {
          // Best-effort.
        }
        return;
      }
      const uploadPathsResult = await resolveStrictExistingUploadPaths({
        requestedPaths: opts.paths,
      });
      if (!uploadPathsResult.ok) {
        try {
          await page.keyboard.press("Escape");
        } catch {
          // Best-effort.
        }
        return;
      }
      await fileChooser.setFiles(uploadPathsResult.paths);
    })
    .catch(() => {
      // Ignore timeouts; the chooser may never appear.
    });
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
