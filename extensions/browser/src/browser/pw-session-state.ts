import { resolveExpiresAtMsFromDurationMs } from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { ConsoleMessage, Dialog, Frame, Page, Request, Response } from "playwright-core";
import { redactBrowserNavigationUrl } from "./navigation-guard.js";
import { saveBrowserDownload, type BrowserDownloadCaptureOptions } from "./pw-download-capture.js";
import {
  MAX_CONSOLE_MESSAGES,
  MAX_NETWORK_REQUESTS,
  MAX_PAGE_ERRORS,
  observedPages,
  pageStates,
  type ArmedDialogResponse,
  type BrowserObservedDialogRecord,
  type BrowserObservedState,
  type BrowserNetworkRequest,
  type BrowserConsoleMessage,
  type DownloadPayload,
  type PageState,
  type RoleRefs,
  type RoleRefsCacheEntry,
  BrowserObservedDialogBlockedError,
} from "./pw-session-contracts.js";
import {
  appendRecentDialog,
  clearArmedDialogResponse,
  observeDialog,
  resolveObservedDialogTimeoutMs,
  resolvePendingDialogForResponse,
  serializeObservedBrowserState,
  settleObservedDialog,
} from "./pw-session-dialogs.js";

// Best-effort cache to make role refs stable even if Playwright returns a different Page object
// for the same CDP target across requests.
const roleRefsByTarget = new Map<string, RoleRefsCacheEntry>();
const MAX_ROLE_REFS_CACHE = 50;
let roleRefsCacheGeneration = 0;
const MAX_OBSERVED_PAGE_TEXT_CHARS = 2_048;

function truncateObservedPageText(value: string): string {
  return truncateUtf16Safe(value, MAX_OBSERVED_PAGE_TEXT_CHARS);
}

export function normalizeCdpUrl(raw: string) {
  return raw.replace(/\/$/, "");
}

function findNetworkRequestById(state: PageState, id: string): BrowserNetworkRequest | undefined {
  for (let i = state.requests.length - 1; i >= 0; i -= 1) {
    const candidate = state.requests[i];
    if (candidate && candidate.id === id) {
      return candidate;
    }
  }
  return undefined;
}

export function targetKey(cdpUrl: string, targetId: string) {
  return `${normalizeCdpUrl(cdpUrl)}::${targetId}`;
}

function roleRefsKey(cdpUrl: string, targetId: string) {
  return targetKey(cdpUrl, targetId);
}

export function bindRoleRefsTarget(page: Page, cdpUrl: string, targetId?: string | null): void {
  const normalizedTargetId = normalizeOptionalString(targetId ?? undefined);
  if (!normalizedTargetId) {
    return;
  }
  const state = ensurePageState(page);
  const key = roleRefsKey(cdpUrl, normalizedTargetId);
  const invalidBeforeGeneration = state.roleRefsInvalidBeforeGeneration;
  const ariaInvalidBeforeGeneration = state.roleRefsAriaInvalidBeforeGeneration;
  const cached = roleRefsByTarget.get(key);
  if (
    cached &&
    ((invalidBeforeGeneration !== undefined && cached.generation <= invalidBeforeGeneration) ||
      (ariaInvalidBeforeGeneration !== undefined &&
        cached.mode === "aria" &&
        cached.generation <= ariaInvalidBeforeGeneration))
  ) {
    roleRefsByTarget.delete(key);
  }
  state.roleRefsInvalidBeforeGeneration = undefined;
  state.roleRefsAriaInvalidBeforeGeneration = undefined;
  state.roleRefsTargetKey = key;
  if (!state.roleRefs) {
    state.roleRefsTargetGeneration = roleRefsByTarget.get(key)?.generation;
  }
}

/** Cache role refs for a target id after a snapshot. */
function rememberRoleRefsForTarget(opts: {
  cdpUrl: string;
  targetId: string;
  refs: RoleRefs;
  frameSelector?: string;
  mode?: NonNullable<PageState["roleRefsMode"]>;
}): number | undefined {
  const targetId = normalizeOptionalString(opts.targetId) ?? "";
  if (!targetId) {
    return undefined;
  }
  const key = roleRefsKey(opts.cdpUrl, targetId);
  // A selector cannot preserve frame identity across replacement Page objects.
  // Frame-scoped refs remain local and require a fresh snapshot after reconnect.
  if (opts.frameSelector) {
    roleRefsByTarget.delete(key);
    return undefined;
  }
  const generation = ++roleRefsCacheGeneration;
  roleRefsByTarget.set(key, {
    refs: opts.refs,
    ...(opts.mode ? { mode: opts.mode } : {}),
    generation,
  });
  while (roleRefsByTarget.size > MAX_ROLE_REFS_CACHE) {
    const first = roleRefsByTarget.keys().next();
    if (first.done) {
      break;
    }
    roleRefsByTarget.delete(first.value);
  }
  return generation;
}

/** Store role refs on the page and target cache. */
export function storeRoleRefsForTarget(opts: {
  page: Page;
  cdpUrl: string;
  targetId?: string;
  refs: RoleRefs;
  frameSelector?: string;
  frame?: Frame;
  mode: NonNullable<PageState["roleRefsMode"]>;
}): void {
  if (opts.frameSelector && !opts.frame) {
    throw new Error("Frame-scoped role refs require their resolved frame.");
  }
  const state = ensurePageState(opts.page);
  state.roleRefs = opts.refs;
  state.roleRefsFrameSelector = opts.frameSelector;
  state.roleRefsFrame = opts.frame;
  state.roleRefsMode = opts.mode;
  const targetId = normalizeOptionalString(opts.targetId);
  if (!targetId) {
    state.roleRefsTargetKey = undefined;
    state.roleRefsTargetGeneration = undefined;
    return;
  }
  bindRoleRefsTarget(opts.page, opts.cdpUrl, targetId);
  state.roleRefsTargetGeneration = rememberRoleRefsForTarget({
    cdpUrl: opts.cdpUrl,
    targetId,
    refs: opts.refs,
    frameSelector: opts.frameSelector,
    mode: opts.mode,
  });
}

function clearRoleRefs(state: PageState): void {
  if (state.roleRefsTargetKey) {
    const cached = roleRefsByTarget.get(state.roleRefsTargetKey);
    // A delayed event from an obsolete Page must not erase refs that a newer
    // wrapper stored for the same target after this Page's generation.
    if (cached?.generation === state.roleRefsTargetGeneration) {
      roleRefsByTarget.delete(state.roleRefsTargetKey);
    }
  }
  state.roleRefs = undefined;
  state.roleRefsMode = undefined;
  state.roleRefsFrameSelector = undefined;
  state.roleRefsFrame = undefined;
  state.roleRefsTargetKey = undefined;
  state.roleRefsTargetGeneration = undefined;
}

function currentTargetRoleRefsMode(
  state: PageState,
): NonNullable<PageState["roleRefsMode"]> | undefined {
  if (!state.roleRefsTargetKey) {
    return undefined;
  }
  const cached = roleRefsByTarget.get(state.roleRefsTargetKey);
  return cached && cached.generation === state.roleRefsTargetGeneration ? cached.mode : undefined;
}

/** Restore cached role refs onto a newly resolved page. */
export function restoreRoleRefsForTarget(opts: {
  cdpUrl: string;
  targetId?: string;
  page: Page;
}): void {
  const targetId = normalizeOptionalString(opts.targetId) ?? "";
  if (!targetId) {
    return;
  }
  const cacheKey = roleRefsKey(opts.cdpUrl, targetId);
  bindRoleRefsTarget(opts.page, opts.cdpUrl, targetId);
  const cached = roleRefsByTarget.get(cacheKey);
  if (!cached) {
    return;
  }
  const state = ensurePageState(opts.page);
  if (state.roleRefs) {
    return;
  }
  state.roleRefsTargetKey = cacheKey;
  state.roleRefsTargetGeneration = cached.generation;
  state.roleRefs = cached.refs;
  state.roleRefsMode = cached.mode;
}

/** Ensure and attach state listeners for a Playwright page. */
export function ensurePageState(page: Page): PageState {
  const existing = pageStates.get(page);
  if (existing) {
    return existing;
  }

  const state: PageState = {
    console: [],
    errors: [],
    requests: [],
    requestIds: new WeakMap(),
    nextRequestId: 0,
    armIdUpload: 0,
    armIdDownload: 0,
    downloadWaiterDepth: 0,
    nextObservedDialogId: 0,
    pendingDialogs: [],
    recentDialogs: [],
    dialogAbortControllers: new Set(),
  };
  pageStates.set(page, state);

  if (!observedPages.has(page)) {
    observedPages.add(page);
    page.on("console", (msg: ConsoleMessage) => {
      const location = msg.location();
      const entry: BrowserConsoleMessage = {
        type: truncateObservedPageText(msg.type()),
        text: truncateObservedPageText(msg.text()),
        timestamp: new Date().toISOString(),
        location: {
          ...location,
          url: truncateObservedPageText(redactBrowserNavigationUrl(location.url)),
        },
      };
      state.console.push(entry);
      if (state.console.length > MAX_CONSOLE_MESSAGES) {
        state.console.shift();
      }
    });
    page.on("pageerror", (err: Error) => {
      state.errors.push({
        message: truncateObservedPageText(err.message || String(err)),
        name: err.name ? truncateObservedPageText(err.name) : undefined,
        stack: err.stack ? truncateObservedPageText(err.stack) : undefined,
        timestamp: new Date().toISOString(),
      });
      if (state.errors.length > MAX_PAGE_ERRORS) {
        state.errors.shift();
      }
    });
    page.on("request", (req: Request) => {
      state.nextRequestId += 1;
      const id = `r${state.nextRequestId}`;
      state.requestIds.set(req, id);
      state.requests.push({
        id,
        timestamp: new Date().toISOString(),
        method: req.method(),
        url: truncateObservedPageText(redactBrowserNavigationUrl(req.url())),
        resourceType: req.resourceType(),
      });
      if (state.requests.length > MAX_NETWORK_REQUESTS) {
        state.requests.shift();
      }
    });
    page.on("response", (resp: Response) => {
      const req = resp.request();
      const id = state.requestIds.get(req);
      if (!id) {
        return;
      }
      const rec = findNetworkRequestById(state, id);
      if (!rec) {
        return;
      }
      rec.status = resp.status();
      rec.ok = resp.ok();
    });
    page.on("requestfailed", (req: Request) => {
      const id = state.requestIds.get(req);
      if (!id) {
        return;
      }
      const rec = findNetworkRequestById(state, id);
      if (!rec) {
        return;
      }
      const failureText = req.failure()?.errorText;
      rec.failureText = failureText ? truncateObservedPageText(failureText) : undefined;
      rec.ok = false;
    });
    page.on("dialog", (dialog: Dialog) => {
      observeDialog(state, dialog);
    });
    page.on("download", (download: DownloadPayload) => {
      if (state.downloadWaiterDepth > 0) {
        return;
      }
      const actionCapture = state.actionDownloadCapture;
      const beforeSave = actionCapture?.beforeSave;
      const captureOptions: BrowserDownloadCaptureOptions | undefined =
        actionCapture && beforeSave
          ? {
              beforeSave: (candidate) => {
                const validation = Promise.resolve().then(() => beforeSave(candidate));
                actionCapture.validations.push(validation);
                return validation;
              },
            }
          : undefined;
      const managedSave = saveBrowserDownload(download, captureOptions);
      managedSave.catch(() => {});
      download.path = async () => (await managedSave).path;
      if (actionCapture) {
        actionCapture.lastEventAtMs = Date.now();
      }
      actionCapture?.pending.push(managedSave);
      for (const finish of actionCapture?.waiters.splice(0) ?? []) {
        finish();
      }
    });
    page.on("framenavigated", (frame) => {
      // Clear role refs on main-frame navigation so stale refs from the
      // previous page are never used to locate elements on the new page.
      // Unscoped refs survive subframe navigation. Frame-scoped refs are
      // invalid only when their exact Frame replaces its document.
      const isMainFrame = frame === page.mainFrame();
      const targetWasBound = state.roleRefsTargetKey !== undefined;
      if (!targetWasBound) {
        // Target discovery is asynchronous. Remember an early navigation so
        // binding removes only cache generations that already existed. Refs a
        // newer Page stores after this event must survive the delayed lookup.
        if (isMainFrame) {
          state.roleRefsInvalidBeforeGeneration = roleRefsCacheGeneration;
        } else {
          state.roleRefsAriaInvalidBeforeGeneration = roleRefsCacheGeneration;
        }
      }
      const pageWideAriaRefs =
        state.roleRefsMode === "aria" || currentTargetRoleRefsMode(state) === "aria";
      if (isMainFrame || pageWideAriaRefs || frame === state.roleRefsFrame) {
        // Replacement Page objects restore from this target cache, so local
        // clearing alone could resurrect refs from the previous document.
        clearRoleRefs(state);
      }
    });
    page.on("framedetached", (frame) => {
      if (!state.roleRefsTargetKey) {
        if (frame === page.mainFrame()) {
          state.roleRefsInvalidBeforeGeneration = roleRefsCacheGeneration;
        } else {
          state.roleRefsAriaInvalidBeforeGeneration = roleRefsCacheGeneration;
        }
      }
      const pageWideAriaRefs =
        state.roleRefsMode === "aria" || currentTargetRoleRefsMode(state) === "aria";
      if (pageWideAriaRefs || frame === state.roleRefsFrame) {
        clearRoleRefs(state);
      }
    });
    page.on("close", () => {
      const emulationSession = state.emulation?.session;
      state.emulation = undefined;
      void emulationSession?.then((session) => session.detach()).catch(() => {});
      clearArmedDialogResponse(state);
      for (const controller of state.dialogAbortControllers) {
        if (!controller.signal.aborted) {
          controller.abort(new Error("Page closed before browser action completed."));
        }
      }
      state.dialogAbortControllers.clear();
      state.pendingDialogs = [];
      pageStates.delete(page);
      observedPages.delete(page);
    });
  }

  return state;
}

/** Read observed dialog state from a Playwright page. */
export function getObservedBrowserStateForPage(page: Page): BrowserObservedState {
  const state = ensurePageState(page);
  return serializeObservedBrowserState(state);
}

/** Resolve a page and read its observed browser state. */

export async function respondToObservedDialogOnPage(opts: {
  page: Page;
  dialogId?: string;
  accept: boolean;
  promptText?: string;
  closedBy?: "agent" | "armed";
}): Promise<BrowserObservedDialogRecord> {
  const state = ensurePageState(opts.page);
  const pending = resolvePendingDialogForResponse({
    state,
    ...(opts.dialogId !== undefined ? { dialogId: opts.dialogId } : {}),
  });
  return await settleObservedDialog({
    state,
    pending,
    accept: opts.accept,
    ...(opts.promptText !== undefined ? { promptText: opts.promptText } : {}),
    closedBy: opts.closedBy ?? "agent",
  });
}

/** Mark pending observed dialogs as handled by a remote/browser-side hook. */
export function markObservedDialogsHandledRemotelyForPage(page: Page): BrowserObservedState {
  const state = ensurePageState(page);
  const pending = state.pendingDialogs.splice(0);
  const closedAt = new Date().toISOString();
  for (const dialog of pending) {
    appendRecentDialog(state, {
      id: dialog.id,
      type: dialog.type,
      message: dialog.message,
      ...(dialog.defaultValue !== undefined ? { defaultValue: dialog.defaultValue } : {}),
      openedAt: dialog.openedAt,
      closedAt,
      closedBy: "remote",
    });
  }
  return serializeObservedBrowserState(state);
}

/** Arm a one-shot automatic dialog response for a page. */
export function armObservedDialogResponseOnPage(opts: {
  page: Page;
  accept: boolean;
  promptText?: string;
  timeoutMs?: number;
}): void {
  const state = ensurePageState(opts.page);
  clearArmedDialogResponse(state);
  const timeoutMs = resolveObservedDialogTimeoutMs(opts.timeoutMs);
  const expiresAt = resolveExpiresAtMsFromDurationMs(timeoutMs);
  if (expiresAt === undefined) {
    return;
  }
  const response: ArmedDialogResponse = {
    accept: opts.accept,
    expiresAt,
    ...(opts.promptText !== undefined ? { promptText: opts.promptText } : {}),
  };
  response.timer = setTimeout(() => {
    if (state.armedDialogResponse === response) {
      state.armedDialogResponse = undefined;
    }
  }, timeoutMs);
  state.armedDialogResponse = response;
}

/** Create an abort signal that fires while a dialog blocks the page. */
export function createObservedDialogAbortSignalForPage(opts: {
  page: Page;
  parentSignal?: AbortSignal;
}): { signal: AbortSignal; cleanup: () => void } {
  const state = ensurePageState(opts.page);
  const controller = new AbortController();
  const abortForCurrentDialog = () => {
    if (!controller.signal.aborted) {
      controller.abort(new BrowserObservedDialogBlockedError(serializeObservedBrowserState(state)));
    }
  };
  const abortForParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(opts.parentSignal?.reason ?? new Error("aborted"));
    }
  };

  if (state.pendingDialogs.length > 0) {
    abortForCurrentDialog();
  } else {
    state.dialogAbortControllers.add(controller);
  }
  if (opts.parentSignal) {
    if (opts.parentSignal.aborted) {
      abortForParent();
    } else {
      opts.parentSignal.addEventListener("abort", abortForParent, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      state.dialogAbortControllers.delete(controller);
      opts.parentSignal?.removeEventListener("abort", abortForParent);
    },
  };
}
