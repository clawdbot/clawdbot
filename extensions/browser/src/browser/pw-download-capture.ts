/** Shared Playwright download capture and output handling. */
import crypto from "node:crypto";
import path from "node:path";
import type { Page } from "playwright-core";
import type { BrowserDownloadCandidate, BrowserDownloadResult } from "./download-types.js";
import { writeExternalFileWithinOutputRoot } from "./output-files.js";
import { DEFAULT_DOWNLOAD_DIR } from "./paths.js";
import { sanitizeUntrustedFileName } from "./safe-filename.js";

type BrowserDownloadCaptureState = {
  downloadWaiterDepth: number;
};

export type BrowserDownloadCaptureOptions = {
  beforeSave?: (download: BrowserDownloadCandidate) => Promise<void> | void;
  mode?: "passive" | "explicit";
  outputPath?: string;
  outputRoot?: string;
  timeoutMessage?: string;
};

export type PlaywrightDownload = {
  cancel?: () => Promise<void>;
  url?: () => string;
  suggestedFilename?: () => string;
  saveAs?: (outPath: string) => Promise<void>;
};

function buildManagedDownloadPath(rootDir: string, fileName: string): string {
  const id = crypto.randomUUID();
  const safeName = sanitizeUntrustedFileName(fileName, "download.bin");
  return path.join(rootDir, `${id}-${safeName}`);
}

/** Validate metadata and atomically save one Playwright download. */
export async function saveBrowserDownload(
  download: PlaywrightDownload,
  opts: BrowserDownloadCaptureOptions = {},
  signal?: AbortSignal,
  onSaveReady?: () => void,
): Promise<BrowserDownloadResult> {
  const suggestedFilename = download.suggestedFilename?.() || "download.bin";
  const candidate: BrowserDownloadCandidate = {
    url: download.url?.() || "",
    suggestedFilename,
  };
  await opts.beforeSave?.(candidate);
  signal?.throwIfAborted();
  const saveAs = download.saveAs?.bind(download);
  if (!saveAs) {
    throw new Error("Download cannot be saved");
  }
  const requestedPath = opts.outputPath?.trim();
  const implicitRoot = opts.outputRoot ?? DEFAULT_DOWNLOAD_DIR;
  const managedPath = requestedPath || buildManagedDownloadPath(implicitRoot, suggestedFilename);
  const savedPath = await writeExternalFileWithinOutputRoot({
    rootDir: requestedPath ? opts.outputRoot : implicitRoot,
    path: managedPath,
    write: async (tempPath) => {
      signal?.throwIfAborted();
      await saveAs(tempPath);
      // Timeout and saveAs race here: timeout leaves the temp unpublished,
      // while a completed save claims the deadline before finalization.
      signal?.throwIfAborted();
      onSaveReady?.();
    },
  });
  return { ...candidate, path: savedPath };
}

/** Arm one page download while maintaining explicit/passive ownership depth. */
export function createDownloadCaptureForPage(
  page: Page,
  state: BrowserDownloadCaptureState,
  timeoutMs: number,
  opts: BrowserDownloadCaptureOptions = {},
): {
  armed: boolean;
  promise: Promise<BrowserDownloadResult>;
  cancel: () => void;
} {
  // Passive action capture yields to an explicit wait/download owner. Explicit
  // waiters may overlap; their arm id decides which one is allowed to save.
  if (opts.mode !== "explicit" && state.downloadWaiterDepth > 0) {
    return {
      armed: false,
      promise: new Promise<BrowserDownloadResult>(() => {}),
      cancel: () => {},
    };
  }

  state.downloadWaiterDepth += 1;
  let phase: "waiting" | "saving" | "settled" = "waiting";
  let depthReleased = false;
  let timer: NodeJS.Timeout | undefined;
  let handler: ((download: unknown) => void) | undefined;
  let activeDownload: PlaywrightDownload | undefined;
  const saveAbortController = new AbortController();

  const releaseWaiter = () => {
    if (!depthReleased) {
      depthReleased = true;
      state.downloadWaiterDepth = Math.max(0, state.downloadWaiterDepth - 1);
    }
    if (handler) {
      page.off("download", handler as never);
      handler = undefined;
    }
  };

  const clearDeadline = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const settle = () => {
    if (phase === "settled") {
      return false;
    }
    phase = "settled";
    releaseWaiter();
    clearDeadline();
    return true;
  };

  const claimSaveDeadline = () => {
    saveAbortController.signal.throwIfAborted();
    clearDeadline();
  };

  const promise = new Promise<BrowserDownloadResult>((resolve, reject) => {
    handler = (download: unknown) => {
      if (phase !== "waiting") {
        return;
      }
      phase = "saving";
      activeDownload = download as PlaywrightDownload;
      releaseWaiter();
      void saveBrowserDownload(
        activeDownload,
        opts,
        saveAbortController.signal,
        claimSaveDeadline,
      ).then(
        (result) => {
          if (settle()) {
            resolve(result);
          }
        },
        (error: unknown) => {
          if (settle()) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      );
    };
    page.on("download", handler as never);
    timer = setTimeout(
      () => {
        const timeoutError = new Error(opts.timeoutMessage ?? "Timeout waiting for download");
        if (!settle()) {
          return;
        }
        saveAbortController.abort(timeoutError);
        // Playwright cleanup is best-effort and must not delay or replace the timeout.
        void activeDownload?.cancel?.().catch(() => {});
        reject(timeoutError);
      },
      Math.max(1, timeoutMs),
    );
    timer.unref?.();
  });

  return {
    armed: true,
    promise,
    cancel: () => {
      if (phase === "settled") {
        return;
      }
      if (phase === "saving") {
        // Passive action capture no longer owns the wait once a download starts.
        // Let the owned save finish, but remove its action-scoped deadline.
        clearDeadline();
        return;
      }
      phase = "settled";
      releaseWaiter();
      clearDeadline();
    },
  };
}
