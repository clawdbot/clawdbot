import type { Frame, Page } from "playwright-core";
import { formatErrorMessage } from "../infra/errors.js";
import {
  ACT_MAX_BATCH_ACTIONS,
  ACT_MAX_BATCH_DEPTH,
  BROWSER_ACTION_NAVIGATION_GRACE_MS,
} from "./act-policy.js";
import type { BrowserBatchAbort, BrowserBatchActionResult } from "./client-actions-types.js";
import type { BrowserActRequest } from "./client-actions.types.js";
import type { BrowserDownloadResult } from "./download-types.js";
import {
  assertBrowserNavigationResultAllowed,
  type BrowserNavigationPolicyOptions,
} from "./navigation-guard.js";
import {
  beginActionDownloadCaptureOnPage,
  createObservedDialogAbortSignalForPage,
  getPageForTargetId,
  isBrowserObservedDialogBlockedError,
  isPolicyDenyNavigationError,
  quarantineBlockedNavigationTarget,
  wasBrowserNavigationSourcePreservedAfterPolicyDenial,
} from "./pw-session.js";
import {
  clickCoordsViaPlaywright,
  clickViaPlaywright,
  dragViaPlaywright,
  evaluateViaPlaywright,
  fillFormViaPlaywright,
  hoverViaPlaywright,
  pressKeyViaPlaywright,
  scrollIntoViewViaPlaywright,
  selectOptionViaPlaywright,
  typeViaPlaywright,
} from "./pw-tools-core.interactions.actions.js";
import { waitForViaPlaywright } from "./pw-tools-core.interactions.content.js";
import {
  type GuardedInteractionOptions,
  hasInteractionNavigationPolicy,
  interactionNavigationPolicy,
} from "./pw-tools-core.interactions.navigation.js";
import { closePageViaPlaywright, resizeViewportViaPlaywright } from "./pw-tools-core.snapshot.js";

const ACT_DOWNLOAD_MAX_DRAIN_MS = 1_000;

async function executeSingleAction(
  action: BrowserActRequest,
  cdpUrl: string,
  targetId?: string,
  evaluateEnabled?: boolean,
  navigationPolicy: BrowserNavigationPolicyOptions = {},
  depth = 0,
  signal?: AbortSignal,
): Promise<unknown> {
  if (depth > ACT_MAX_BATCH_DEPTH) {
    throw new Error(`Batch nesting depth exceeds maximum of ${ACT_MAX_BATCH_DEPTH}`);
  }
  const effectiveTargetId = action.targetId ?? targetId;
  switch (action.kind) {
    case "click":
      await clickViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        doubleClick: action.doubleClick,
        button: action.button as "left" | "right" | "middle" | undefined,
        modifiers: action.modifiers as Array<
          "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift"
        >,
        delayMs: action.delayMs,
        timeoutMs: action.timeoutMs,
        ...navigationPolicy,
        signal,
      });
      break;
    case "clickCoords":
      await clickCoordsViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        x: action.x,
        y: action.y,
        doubleClick: action.doubleClick,
        button: action.button as "left" | "right" | "middle" | undefined,
        delayMs: action.delayMs,
        ...navigationPolicy,
        signal,
      });
      break;
    case "type":
      await typeViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        text: action.text,
        submit: action.submit,
        slowly: action.slowly,
        timeoutMs: action.timeoutMs,
        ...navigationPolicy,
        signal,
      });
      break;
    case "press":
      await pressKeyViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        key: action.key,
        delayMs: action.delayMs,
        ...navigationPolicy,
        signal,
      });
      break;
    case "hover":
      await hoverViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        timeoutMs: action.timeoutMs,
        ...navigationPolicy,
        signal,
      });
      break;
    case "scrollIntoView":
      await scrollIntoViewViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        timeoutMs: action.timeoutMs,
        ...navigationPolicy,
        signal,
      });
      break;
    case "drag":
      await dragViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        startRef: action.startRef,
        startSelector: action.startSelector,
        endRef: action.endRef,
        endSelector: action.endSelector,
        timeoutMs: action.timeoutMs,
        ...navigationPolicy,
        signal,
      });
      break;
    case "select":
      await selectOptionViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        values: action.values,
        timeoutMs: action.timeoutMs,
        ...navigationPolicy,
        signal,
      });
      break;
    case "fill":
      await fillFormViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        fields: action.fields,
        timeoutMs: action.timeoutMs,
        ...navigationPolicy,
        signal,
      });
      break;
    case "resize":
      await resizeViewportViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        width: action.width,
        height: action.height,
      });
      break;
    case "wait":
      if (action.fn && !evaluateEnabled) {
        throw new Error("wait --fn is disabled by config (browser.evaluateEnabled=false)");
      }
      await waitForViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        timeMs: action.timeMs,
        text: action.text,
        textGone: action.textGone,
        selector: action.selector,
        url: action.url,
        loadState: action.loadState,
        fn: action.fn,
        timeoutMs: action.timeoutMs,
        ...navigationPolicy,
        signal,
      });
      break;
    case "evaluate":
      if (!evaluateEnabled) {
        throw new Error("act:evaluate is disabled by config (browser.evaluateEnabled=false)");
      }
      return await evaluateViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ...navigationPolicy,
        fn: action.fn,
        ref: action.ref,
        timeoutMs: action.timeoutMs,
        signal,
      });
    case "close":
      await closePageViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
      });
      break;
    case "batch":
      await batchViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ...navigationPolicy,
        actions: action.actions,
        stopOnError: action.stopOnError,
        evaluateEnabled,
        depth: depth + 1,
        signal,
      });
      break;
    default:
      throw new Error(`Unsupported batch action kind: ${(action as { kind: string }).kind}`);
  }
  return undefined;
}

function actionUsesNavigationRequestGuard(action: BrowserActRequest): boolean {
  if (action.kind === "batch") {
    return action.actions.some(actionUsesNavigationRequestGuard);
  }
  return action.kind === "wait"
    ? Boolean(action.fn)
    : action.kind !== "close" && action.kind !== "resize";
}

function actionNeedsStandaloneDownloadGrace(
  action: BrowserActRequest,
  navigationPolicy: BrowserNavigationPolicyOptions,
): boolean {
  // Guarded interactions already hold a 250 ms event window while policy is
  // active. Policy-free internal callers need that window from download capture.
  return (
    actionUsesNavigationRequestGuard(action) && !hasInteractionNavigationPolicy(navigationPolicy)
  );
}

export async function executeActViaPlaywright(
  opts: GuardedInteractionOptions & {
    action: BrowserActRequest;
    evaluateEnabled?: boolean;
  },
): Promise<{
  result?: unknown;
  results?: BrowserBatchActionResult[];
  aborted?: BrowserBatchAbort;
  blockedByDialog?: boolean;
  browserState?: unknown;
  downloads?: BrowserDownloadResult[];
}> {
  const navigationPolicy = interactionNavigationPolicy(opts);
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });
  // Any DOM action can synchronously trigger a download. Capturing all actions
  // keeps reporting and final-URL policy aligned with the actual file write.
  const downloadCapture = beginActionDownloadCaptureOnPage(page, {
    beforeSave: async (download) => {
      if (!download.url) {
        throw new Error("Action download URL is unavailable");
      }
      await assertBrowserNavigationResultAllowed({
        url: download.url,
        ...navigationPolicy,
      });
    },
  });
  const downloadGraceMs = actionNeedsStandaloneDownloadGrace(opts.action, navigationPolicy)
    ? BROWSER_ACTION_NAVIGATION_GRACE_MS
    : 0;
  const drainDownloads = async (firstEventGraceMs = downloadGraceMs) =>
    await downloadCapture.drain({
      firstEventGraceMs,
      maxWaitMs: ACT_DOWNLOAD_MAX_DRAIN_MS,
      quietMs: BROWSER_ACTION_NAVIGATION_GRACE_MS,
    });
  const dialogAbort = createObservedDialogAbortSignalForPage({
    page,
    parentSignal: opts.signal,
  });
  try {
    if (opts.action.kind === "batch") {
      const batch = await batchViaPlaywright({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        page,
        ...navigationPolicy,
        actions: opts.action.actions,
        stopOnError: opts.action.stopOnError,
        evaluateEnabled: opts.evaluateEnabled,
        signal: dialogAbort.signal,
      });
      const newDownloads = await drainDownloads();
      return {
        results: batch.results,
        ...(batch.aborted ? { aborted: batch.aborted } : {}),
        ...(newDownloads ? { downloads: newDownloads } : {}),
      };
    }
    const result = await executeSingleAction(
      opts.action,
      opts.cdpUrl,
      opts.targetId,
      opts.evaluateEnabled,
      navigationPolicy,
      0,
      dialogAbort.signal,
    );
    const newDownloads = await drainDownloads();
    if (opts.action.kind === "evaluate") {
      return { result, ...(newDownloads ? { downloads: newDownloads } : {}) };
    }
    return newDownloads ? { downloads: newDownloads } : {};
  } catch (err) {
    let failure = err;
    try {
      const failureGraceMs =
        dialogAbort.signal.aborted && actionUsesNavigationRequestGuard(opts.action)
          ? BROWSER_ACTION_NAVIGATION_GRACE_MS
          : downloadGraceMs;
      await drainDownloads(failureGraceMs);
    } catch (downloadErr) {
      // A download policy/save failure is the action's network-to-file result;
      // preserve it even when the initiating interaction also failed.
      failure = downloadErr;
    }
    if (isBrowserObservedDialogBlockedError(failure)) {
      return { blockedByDialog: true, browserState: failure.browserState };
    }
    if (
      isPolicyDenyNavigationError(failure) &&
      !wasBrowserNavigationSourcePreservedAfterPolicyDenial(failure)
    ) {
      await quarantineBlockedNavigationTarget({
        cdpUrl: opts.cdpUrl,
        page,
        targetId: opts.targetId,
      });
    }
    throw failure;
  } finally {
    downloadCapture.dispose();
    dialogAbort.cleanup();
  }
}

export async function batchViaPlaywright(
  opts: GuardedInteractionOptions & {
    actions: BrowserActRequest[];
    stopOnError?: boolean;
    evaluateEnabled?: boolean;
    depth?: number;
    page?: Page;
  },
): Promise<{ results: BrowserBatchActionResult[]; aborted?: BrowserBatchAbort }> {
  const navigationPolicy = interactionNavigationPolicy(opts);
  const depth = opts.depth ?? 0;
  if (depth > ACT_MAX_BATCH_DEPTH) {
    throw new Error(`Batch nesting depth exceeds maximum of ${ACT_MAX_BATCH_DEPTH}`);
  }
  if (opts.actions.length > ACT_MAX_BATCH_ACTIONS) {
    throw new Error(`Batch exceeds maximum of ${ACT_MAX_BATCH_ACTIONS} actions`);
  }
  const page = opts.page ?? (await getPageForTargetId(opts));
  const results: BrowserBatchActionResult[] = [];
  const finishAborted = (
    reason: BrowserBatchAbort["reason"],
    afterAction: number,
    url: string,
    skipped: number,
  ) =>
    skipped === 0
      ? { results }
      : { results, aborted: { reason, afterAction, url, skipped } satisfies BrowserBatchAbort };
  let mainFrameNavigations = 0;
  let navigationsAtLastDispatch = 0;
  const currentMainFrameUrl = () => page.mainFrame?.().url() ?? page.url();
  const onFrameNavigated = (frame: Frame) => {
    if (frame === page.mainFrame?.()) {
      mainFrameNavigations += 1;
    }
  };
  const finishNavigation = (afterAction: number, skipped: number) => {
    const url = currentMainFrameUrl();
    const lastResult = results.at(-1);
    if (lastResult) {
      results[results.length - 1] = { ...lastResult, navigated: true, url };
    }
    return finishAborted("navigation", afterAction, url, skipped);
  };

  // Snapshot refs are document-scoped, so any committed main-frame navigation
  // ends the batch. A commit after the next action dispatch is inherently unguardable;
  // callers that expect navigation can use separate act calls as the escape hatch.
  page.on?.("framenavigated", onFrameNavigated);
  try {
    for (const [index, action] of opts.actions.entries()) {
      if (opts.signal?.aborted) {
        throw opts.signal.reason ?? new Error("aborted");
      }
      if (mainFrameNavigations > navigationsAtLastDispatch) {
        return finishNavigation(index, opts.actions.length - index);
      }
      if (page.isClosed?.()) {
        return finishAborted("closed", index, currentMainFrameUrl(), opts.actions.length - index);
      }
      navigationsAtLastDispatch = mainFrameNavigations;
      try {
        await executeSingleAction(
          action,
          opts.cdpUrl,
          opts.targetId,
          opts.evaluateEnabled,
          navigationPolicy,
          depth,
          opts.signal,
        );
        results.push({ ok: true });
        if (page.isClosed?.()) {
          return finishAborted(
            "closed",
            index + 1,
            currentMainFrameUrl(),
            opts.actions.length - index - 1,
          );
        }
        if (mainFrameNavigations > navigationsAtLastDispatch) {
          return finishNavigation(index + 1, opts.actions.length - index - 1);
        }
      } catch (err) {
        if (isBrowserObservedDialogBlockedError(err)) {
          throw err;
        }
        if (isPolicyDenyNavigationError(err)) {
          throw err;
        }
        const message = formatErrorMessage(err);
        results.push({ ok: false, error: message });
        if (page.isClosed?.()) {
          return finishAborted(
            "closed",
            index + 1,
            currentMainFrameUrl(),
            opts.actions.length - index - 1,
          );
        }
        if (mainFrameNavigations > navigationsAtLastDispatch) {
          return finishNavigation(index + 1, opts.actions.length - index - 1);
        }
        if (opts.stopOnError !== false) {
          break;
        }
      }
    }
    return { results };
  } finally {
    page.off?.("framenavigated", onFrameNavigated);
  }
}
