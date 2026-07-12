/**
 * Playwright-backed browser interaction tools, including clicks, form input,
 * screenshots, batch actions, and SSRF-aware post-interaction navigation checks.
 */
import { resolveNonNegativeIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { FileChooser, Frame, Page } from "playwright-core";
import { formatErrorMessage } from "../infra/errors.js";
import {
  ACT_MAX_BATCH_ACTIONS,
  ACT_MAX_BATCH_DEPTH,
  ACT_MAX_CLICK_DELAY_MS,
  ACT_MAX_WAIT_TIME_MS,
  BROWSER_ACTION_NAVIGATION_GRACE_MS,
  resolveActInteractionTimeoutMs,
  resolveActWaitTimeoutMs,
} from "./act-policy.js";
import type { BrowserActRequest, BrowserFormField } from "./client-actions.types.js";
import type { BrowserDownloadResult } from "./download-types.js";
import { normalizeBrowserEvaluateFunctionSource } from "./evaluate-source.js";
import { DEFAULT_FILL_FIELD_TYPE } from "./form-fields.js";
import {
  assertBrowserNavigationResultAllowed,
  type BrowserNavigationPolicyOptions,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import { resolveStrictExistingUploadPaths } from "./paths.js";
import {
  assertPageNavigationCompletedSafely,
  beginActionDownloadCaptureOnPage,
  createObservedDialogAbortSignalForPage,
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  isBrowserObservedDialogBlockedError,
  isPolicyDenyNavigationError,
  markObservedDialogsHandledRemotelyForPage,
  quarantineBlockedNavigationTarget,
  refLocator,
  restoreRoleRefsForTarget,
  wasBrowserNavigationSourcePreservedAfterPolicyDenial,
  withPageNavigationRequestGuard,
} from "./pw-session.js";
import {
  normalizeTimeoutMs,
  requireRef,
  requireRefOrSelector,
  toAIFriendlyError,
} from "./pw-tools-core.shared.js";
import { closePageViaPlaywright, resizeViewportViaPlaywright } from "./pw-tools-core.snapshot.js";
import {
  ANNOTATION_MAX_LABELS_DEFAULT,
  type AnnotationItem,
  buildOverlayClearScript,
  buildOverlayInjectionScript,
  type CoordinateSpace,
  planAnnotations,
  type RawAnnotationInput,
} from "./screenshot-annotate.js";

type TargetOpts = {
  cdpUrl: string;
  targetId?: string;
};

const ACT_DOWNLOAD_MAX_DRAIN_MS = 1_000;

function interactionNavigationPolicy(
  opts: BrowserNavigationPolicyOptions,
): BrowserNavigationPolicyOptions {
  return withBrowserNavigationPolicy(opts.ssrfPolicy, {
    browserProxyMode: opts.browserProxyMode,
  });
}

function hasInteractionNavigationPolicy(policy: BrowserNavigationPolicyOptions): boolean {
  return Boolean(policy.ssrfPolicy || policy.browserProxyMode);
}

type NavigationObservablePage = Pick<Page, "url"> & {
  mainFrame?: () => Frame;
  on?: (event: "framenavigated", listener: (frame: Frame) => void) => unknown;
  off?: (event: "framenavigated", listener: (frame: Frame) => void) => unknown;
};

const pendingInteractionNavigationGuardCleanup = new WeakMap<Page, () => void>();

function resolveBoundedDelayMs(value: number | undefined, label: string, maxMs: number): number {
  const normalized = Math.floor(value ?? 0);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`${label} must be >= 0`);
  }
  if (normalized > maxMs) {
    throw new Error(`${label} exceeds maximum of ${maxMs}ms`);
  }
  return normalized;
}

async function getRestoredPageForTarget(opts: TargetOpts) {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  return page;
}

function toFriendlyInteractionError(err: unknown, label: string): Error {
  return isBrowserObservedDialogBlockedError(err) ? err : toAIFriendlyError(err, label);
}

function reconcileRemoteDialogAfterActionSettled(page: Page, signal?: AbortSignal): void {
  if (isBrowserObservedDialogBlockedError(signal?.reason)) {
    markObservedDialogsHandledRemotelyForPage(page);
  }
}

function throwIfInteractionAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw toLintErrorObject(signal.reason ?? new Error("aborted"), "Non-Error rejection");
  }
}

const resolveInteractionTimeoutMs = resolveActInteractionTimeoutMs;

// Returns true only when the URL change indicates a cross-document navigation
// (i.e., a real network fetch occurred). Same-document hash-only mutations —
// anchor clicks and history.pushState/replaceState that change only the
// fragment — do not cause a network request and must not trigger SSRF checks.
function didCrossDocumentUrlChange(page: { url(): string }, previousUrl: string): boolean {
  const currentUrl = page.url();
  if (currentUrl === previousUrl) {
    return false;
  }
  try {
    const prev = new URL(previousUrl);
    const curr = new URL(currentUrl);
    if (
      prev.origin === curr.origin &&
      prev.pathname === curr.pathname &&
      prev.search === curr.search
    ) {
      // Only the fragment changed — same-document navigation, no fetch.
      return false;
    }
  } catch {
    // Non-parseable URL; fall through to string comparison.
  }
  return true;
}

// Returns true when a framenavigated event represents only a hash-only
// same-document mutation (no network request). Used in event-driven checks
// where the event itself is the navigation signal — unlike URL polling, we
// cannot use identical URLs as a "no navigation" sentinel because same-URL
// reloads and form submits also fire framenavigated with an unchanged URL.
function isHashOnlyNavigation(currentUrl: string, previousUrl: string): boolean {
  if (currentUrl === previousUrl) {
    // Exact same URL + framenavigated firing = reload or form submit, not a
    // fragment hop. Must run SSRF checks.
    return false;
  }
  try {
    const prev = new URL(previousUrl);
    const curr = new URL(currentUrl);
    return (
      prev.origin === curr.origin && prev.pathname === curr.pathname && prev.search === curr.search
    );
  } catch {
    return false;
  }
}

function isMainFrameNavigation(page: NavigationObservablePage, frame: Frame): boolean {
  if (typeof page.mainFrame !== "function") {
    return true;
  }
  return frame === page.mainFrame();
}

async function assertSubframeNavigationAllowed(
  frameUrl: string,
  navigationPolicy: BrowserNavigationPolicyOptions,
): Promise<void> {
  if (
    (!navigationPolicy.ssrfPolicy && !navigationPolicy.browserProxyMode) ||
    (!frameUrl.startsWith("http://") && !frameUrl.startsWith("https://"))
  ) {
    // Non-network frame URLs like about:blank and about:srcdoc do not cross the
    // browser SSRF boundary, so they should not trigger the navigation policy.
    return;
  }

  await assertBrowserNavigationResultAllowed({
    url: frameUrl,
    ...navigationPolicy,
  });
}

type ObservedDelayedNavigations = {
  mainFrameNavigated: boolean;
  subframes: string[];
};

function snapshotNetworkFrameUrl(frame: Frame): string | null {
  try {
    const frameUrl = frame.url();
    return frameUrl.startsWith("http://") || frameUrl.startsWith("https://") ? frameUrl : null;
  } catch {
    return null;
  }
}

async function assertObservedDelayedNavigations(
  opts: {
    cdpUrl: string;
    page: Page;
    targetId?: string;
    observed: ObservedDelayedNavigations;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const navigationPolicy = interactionNavigationPolicy(opts);
  let subframeError: unknown;
  try {
    for (const frameUrl of opts.observed.subframes) {
      await assertSubframeNavigationAllowed(frameUrl, navigationPolicy);
    }
  } catch (err) {
    subframeError = err;
  }
  if (opts.observed.mainFrameNavigated) {
    await assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      response: null,
      ...navigationPolicy,
      targetId: opts.targetId,
    });
  }
  if (subframeError) {
    throw toLintErrorObject(subframeError, "Non-Error thrown");
  }
}

function observeDelayedInteractionNavigation(
  page: NavigationObservablePage,
  previousUrl: string,
): Promise<ObservedDelayedNavigations> {
  if (didCrossDocumentUrlChange(page, previousUrl)) {
    return Promise.resolve({ mainFrameNavigated: true, subframes: [] });
  }
  if (typeof page.on !== "function" || typeof page.off !== "function") {
    return Promise.resolve({ mainFrameNavigated: false, subframes: [] });
  }

  return new Promise<ObservedDelayedNavigations>((resolve) => {
    const subframes: string[] = [];
    const onFrameNavigated = (frame: Frame) => {
      if (!isMainFrameNavigation(page, frame)) {
        const frameUrl = snapshotNetworkFrameUrl(frame);
        if (frameUrl) {
          subframes.push(frameUrl);
        }
        return;
      }
      // Use isHashOnlyNavigation rather than !didCrossDocumentUrlChange: the
      // event firing is itself the navigation signal, so a same-URL reload must
      // not be treated as "no navigation" the way URL polling would.
      if (isHashOnlyNavigation(page.url(), previousUrl)) {
        return;
      }
      cleanup();
      resolve({ mainFrameNavigated: true, subframes });
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve({
        mainFrameNavigated: didCrossDocumentUrlChange(page, previousUrl),
        subframes,
      });
    }, BROWSER_ACTION_NAVIGATION_GRACE_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      // Call off directly on page (not via a cached reference) to preserve
      // Playwright's EventEmitter `this` binding.
      page.off!("framenavigated", onFrameNavigated);
    };

    // Call on directly on page (not via a cached reference) to preserve
    // Playwright's EventEmitter `this` binding.
    page.on!("framenavigated", onFrameNavigated);
  });
}

function scheduleDelayedInteractionNavigationGuard(
  opts: {
    cdpUrl: string;
    page: Page;
    previousUrl: string;
    targetId?: string;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const navigationPolicy = interactionNavigationPolicy(opts);
  if (!hasInteractionNavigationPolicy(navigationPolicy)) {
    return Promise.resolve();
  }
  const page = opts.page as unknown as NavigationObservablePage;
  if (didCrossDocumentUrlChange(page, opts.previousUrl)) {
    return assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      response: null,
      ...navigationPolicy,
      targetId: opts.targetId,
    });
  }
  if (typeof page.on !== "function" || typeof page.off !== "function") {
    return Promise.resolve();
  }

  pendingInteractionNavigationGuardCleanup.get(opts.page)?.();

  return new Promise<void>((resolve, reject) => {
    const settle = (err?: unknown) => {
      cleanup();
      if (err) {
        reject(toLintErrorObject(err, "Non-Error rejection"));
        return;
      }
      resolve();
    };
    const subframes: string[] = [];
    const onFrameNavigated = (frame: Frame) => {
      if (!isMainFrameNavigation(page, frame)) {
        const frameUrl = snapshotNetworkFrameUrl(frame);
        if (frameUrl) {
          subframes.push(frameUrl);
        }
        return;
      }
      // Use isHashOnlyNavigation rather than !didCrossDocumentUrlChange: the
      // event firing is itself the navigation signal, so a same-URL reload must
      // not be treated as "no navigation" the way URL polling would.
      if (isHashOnlyNavigation(page.url(), opts.previousUrl)) {
        return;
      }
      cleanup();
      void assertObservedDelayedNavigations({
        cdpUrl: opts.cdpUrl,
        page: opts.page,
        ...navigationPolicy,
        targetId: opts.targetId,
        observed: { mainFrameNavigated: true, subframes },
      }).then(() => settle(), settle);
    };
    const timeout = setTimeout(() => {
      cleanup();
      void assertObservedDelayedNavigations({
        cdpUrl: opts.cdpUrl,
        page: opts.page,
        ...navigationPolicy,
        targetId: opts.targetId,
        observed: {
          mainFrameNavigated: didCrossDocumentUrlChange(page, opts.previousUrl),
          subframes,
        },
      }).then(() => settle(), settle);
    }, BROWSER_ACTION_NAVIGATION_GRACE_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      page.off!("framenavigated", onFrameNavigated);
      if (pendingInteractionNavigationGuardCleanup.get(opts.page) === settle) {
        pendingInteractionNavigationGuardCleanup.delete(opts.page);
      }
    };

    pendingInteractionNavigationGuardCleanup.set(opts.page, settle);
    page.on!("framenavigated", onFrameNavigated);
  });
}

async function assertInteractionNavigationCompletedSafely<T>(
  opts: {
    action: () => Promise<T>;
    cdpUrl: string;
    page: Page;
    previousUrl: string;
    targetId?: string;
  } & BrowserNavigationPolicyOptions,
): Promise<T> {
  const navigationPolicy = interactionNavigationPolicy(opts);
  if (!hasInteractionNavigationPolicy(navigationPolicy)) {
    return await opts.action();
  }
  // Phase 1: keep a framenavigated listener alive for the entire duration of the
  // action so navigations triggered mid-click or mid-evaluate are not missed.
  // Using a fixed pre-action timer would expire before the action finishes for
  // slow interactions, silently bypassing the SSRF guard.
  const navPage = opts.page as unknown as NavigationObservablePage;
  let navigatedDuringAction = false;
  const subframeNavigationsDuringAction: string[] = [];
  const onFrameNavigated = (frame: Frame) => {
    if (!isMainFrameNavigation(navPage, frame)) {
      const frameUrl = snapshotNetworkFrameUrl(frame);
      if (frameUrl) {
        subframeNavigationsDuringAction.push(frameUrl);
      }
      return;
    }
    // Use isHashOnlyNavigation rather than didCrossDocumentUrlChange: the event
    // firing is the navigation signal, so a same-URL reload must not be skipped
    // the way it would be by URL-equality polling.
    if (!isHashOnlyNavigation(opts.page.url(), opts.previousUrl)) {
      navigatedDuringAction = true;
    }
  };
  if (typeof navPage.on === "function") {
    navPage.on("framenavigated", onFrameNavigated);
  }

  let result: T | undefined;
  let actionError: unknown = null;
  try {
    result = await opts.action();
  } catch (err) {
    actionError = err;
  } finally {
    if (typeof navPage.off === "function") {
      navPage.off("framenavigated", onFrameNavigated);
    }
  }

  const navigationObserved =
    navigatedDuringAction || didCrossDocumentUrlChange(opts.page, opts.previousUrl);

  let subframeError: unknown;
  try {
    for (const frameUrl of subframeNavigationsDuringAction) {
      await assertSubframeNavigationAllowed(frameUrl, navigationPolicy);
    }
  } catch (err) {
    subframeError = err;
  }

  if (navigationObserved) {
    await assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      response: null,
      ...navigationPolicy,
      targetId: opts.targetId,
    });
  } else if (actionError) {
    // Preserve the action-error path semantics: if a rejected click/evaluate still
    // triggers a delayed navigation, the SSRF block must win over the original
    // action error instead of surfacing a stale interaction failure.
    const observed = await observeDelayedInteractionNavigation(opts.page, opts.previousUrl);
    if (observed.mainFrameNavigated || observed.subframes.length > 0) {
      await assertObservedDelayedNavigations({
        cdpUrl: opts.cdpUrl,
        page: opts.page,
        ...navigationPolicy,
        targetId: opts.targetId,
        observed,
      });
    }
  } else {
    // Successful interactions still need a short grace window: a click can resolve
    // before the navigation event fires, and a blocked late hop must be observable
    // to the current caller instead of only quarantining the page in the background.
    await scheduleDelayedInteractionNavigationGuard({
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      previousUrl: opts.previousUrl,
      ...navigationPolicy,
      targetId: opts.targetId,
    });
  }

  if (subframeError) {
    throw toLintErrorObject(subframeError, "Non-Error thrown");
  }

  if (actionError) {
    throw toLintErrorObject(actionError, "Non-Error thrown");
  }
  return result as T;
}

async function awaitActionWithAbort<T>(
  actionPromise: Promise<T>,
  abortPromise?: Promise<never>,
  onActionResolvedAfterAbort?: () => void,
): Promise<T> {
  if (!abortPromise) {
    return await actionPromise;
  }
  try {
    return await Promise.race([actionPromise, abortPromise]);
  } catch (err) {
    // If abort wins the race, the action may reject later; avoid unhandled rejections.
    void actionPromise.then(
      () => onActionResolvedAfterAbort?.(),
      () => {},
    );
    throw err;
  }
}

async function awaitNavigationGuardedInteraction<T>(
  opts: {
    action: () => Promise<T>;
    cdpUrl: string;
    page: Page;
    targetId?: string;
  } & BrowserNavigationPolicyOptions,
  abortPromise?: Promise<never>,
  signal?: AbortSignal,
  onActionResolvedAfterAbort?: () => void,
): Promise<T> {
  type PolicyCheckOutcome = { state: "allowed" } | { state: "failed"; error: unknown };
  const navigationPolicy = interactionNavigationPolicy(opts);
  const hasNavigationPolicy = hasInteractionNavigationPolicy(navigationPolicy);
  let observedPolicyError: unknown;
  const activePolicyChecks = new Set<Promise<PolicyCheckOutcome>>();
  let unsafeSourceQuarantine: Promise<void> | undefined;
  const quarantineUnsafeSource = () =>
    (unsafeSourceQuarantine ??= quarantineBlockedNavigationTarget({
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      targetId: opts.targetId,
    }));
  const guardedAction = withPageNavigationRequestGuard({
    page: opts.page,
    ...navigationPolicy,
    onPolicyCheckStarted: (check) => {
      const tracked = check.then<PolicyCheckOutcome, PolicyCheckOutcome>(
        () => ({ state: "allowed" }),
        (error: unknown) => ({ state: "failed", error }),
      );
      activePolicyChecks.add(tracked);
      void tracked.then((outcome) => {
        // Keep failures until this interaction settles so an abort cannot race
        // between a denied decision and its route-handler continuation.
        if (outcome.state === "allowed") {
          activePolicyChecks.delete(tracked);
        }
      });
    },
    onPolicyDenied: (event) => {
      observedPolicyError = event.error;
      if (event.state === "handled" && !event.sourcePreserved) {
        void quarantineUnsafeSource().catch(() => {});
      }
    },
    action: async (baselineUrl) => {
      let actionSettledAtMs: number | undefined;
      try {
        return await assertInteractionNavigationCompletedSafely({
          ...opts,
          action: async () => {
            try {
              throwIfInteractionAborted(signal);
              return await opts.action();
            } finally {
              actionSettledAtMs = Date.now();
            }
          },
          previousUrl: baselineUrl,
        });
      } finally {
        if (hasNavigationPolicy && actionSettledAtMs !== undefined) {
          // The canonical post-check can settle on the first safe navigation.
          // Keep request interception for the full grace after the raw action.
          const elapsedMs = Math.max(0, Date.now() - actionSettledAtMs);
          const remainingMs = Math.max(0, BROWSER_ACTION_NAVIGATION_GRACE_MS - elapsedMs);
          if (remainingMs > 0) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, remainingMs);
            });
          }
          // The canonical observer can settle on an earlier safe navigation.
          // Recheck the final committed URL before releasing request routing.
          await assertPageNavigationCompletedSafely({
            cdpUrl: opts.cdpUrl,
            page: opts.page,
            response: null,
            ...navigationPolicy,
            targetId: opts.targetId,
          });
        }
      }
    },
  }).catch(async (err: unknown) => {
    if (
      isPolicyDenyNavigationError(err) &&
      !wasBrowserNavigationSourcePreservedAfterPolicyDenial(err)
    ) {
      await quarantineUnsafeSource();
    }
    throw err;
  });
  try {
    return await awaitActionWithAbort(guardedAction, abortPromise, onActionResolvedAfterAbort);
  } catch (err) {
    if (observedPolicyError === undefined && activePolicyChecks.size > 0) {
      const outcomes = await Promise.all(activePolicyChecks);
      observedPolicyError = outcomes.find(
        (outcome): outcome is Extract<PolicyCheckOutcome, { state: "failed" }> =>
          outcome.state === "failed" && isPolicyDenyNavigationError(outcome.error),
      )?.error;
    }
    if (observedPolicyError !== undefined) {
      // Once policy denial is observed, keep the route and source-state owner
      // alive until the raw action settles; otherwise an aborted caller could
      // select a page before a later preservation failure is quarantined.
      await guardedAction;
      throw toLintErrorObject(observedPolicyError, "Non-Error thrown");
    }
    throw err;
  }
}

function createAbortPromise(signal?: AbortSignal): {
  abortPromise?: Promise<never>;
  cleanup: () => void;
} {
  return createAbortPromiseWithListener(signal);
}

function createAbortPromiseWithListener(
  signal?: AbortSignal,
  onAbort?: (reason: unknown) => void,
): {
  abortPromise?: Promise<never>;
  cleanup: () => void;
} {
  if (!signal) {
    return { cleanup: () => {} };
  }
  let abortListener: (() => void) | undefined;
  const abortPromise: Promise<never> = signal.aborted
    ? (() => {
        onAbort?.(signal.reason);
        return Promise.reject(
          toLintErrorObject(signal.reason ?? new Error("aborted"), "Non-Error rejection"),
        );
      })()
    : new Promise((_, reject) => {
        abortListener = () => {
          onAbort?.(signal.reason);
          reject(toLintErrorObject(signal.reason ?? new Error("aborted"), "Non-Error rejection"));
        };
        signal.addEventListener("abort", abortListener, { once: true });
      });
  // Avoid unhandled rejections on early returns.
  void abortPromise.catch(() => {});
  return {
    abortPromise,
    cleanup: () => {
      if (abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    },
  };
}
/** Highlights a role ref in the target page for visual inspection. */
export async function highlightViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
}): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const ref = requireRef(opts.ref);
  try {
    await refLocator(page, ref).highlight();
  } catch (err) {
    throw toFriendlyInteractionError(err, ref);
  }
}

/** Clicks or double-clicks a role ref or selector with dialog and navigation guards. */
export async function clickViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    ref?: string;
    selector?: string;
    doubleClick?: boolean;
    button?: "left" | "right" | "middle";
    modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
    delayMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    resolvedPage?: Page;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = opts.resolvedPage ?? (await getRestoredPageForTarget(opts));
  if (opts.resolvedPage) {
    ensurePageState(page);
    restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  }
  const label = resolved.ref ?? resolved.selector!;
  const locator = resolved.ref
    ? refLocator(page, requireRef(resolved.ref))
    : page.locator(resolved.selector!);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);
  const signal = opts.signal;
  let abortListener: (() => void) | undefined;
  let abortReject: ((reason: unknown) => void) | undefined;
  let abortPromise: Promise<never> | undefined;
  if (signal) {
    abortPromise = new Promise((_, reject) => {
      abortReject = reject;
    });
    void abortPromise.catch(() => {});
    const disconnect = () => {
      if (isBrowserObservedDialogBlockedError(signal.reason)) {
        return;
      }
      void forceDisconnectPlaywrightForTarget({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        ssrfPolicy: opts.ssrfPolicy,
        reason: "click aborted",
      }).catch(() => {});
    };
    if (signal.aborted) {
      disconnect();
      throw signal.reason ?? new Error("aborted");
    }
    abortListener = () => {
      disconnect();
      abortReject?.(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) {
      abortListener();
      throw signal.reason ?? new Error("aborted");
    }
  }
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, signal);
  try {
    await awaitNavigationGuardedInteraction(
      {
        action: async () => {
          const delayMs = resolveBoundedDelayMs(
            opts.delayMs,
            "click delayMs",
            ACT_MAX_CLICK_DELAY_MS,
          );
          if (delayMs > 0) {
            await locator.hover({ timeout });
            throwIfInteractionAborted(signal);
            await new Promise((resolve) => {
              setTimeout(resolve, delayMs);
            });
            throwIfInteractionAborted(signal);
          }
          if (opts.doubleClick) {
            await locator.dblclick({
              timeout,
              button: opts.button,
              modifiers: opts.modifiers,
            });
            return;
          }
          await locator.click({
            timeout,
            button: opts.button,
            modifiers: opts.modifiers,
          });
        },
        cdpUrl: opts.cdpUrl,
        page,
        ...interactionNavigationPolicy(opts),
        targetId: opts.targetId,
      },
      abortPromise,
      signal,
      reconcileRemoteDialog,
    );
  } catch (err) {
    throw toFriendlyInteractionError(err, label);
  } finally {
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

/** Clicks absolute page coordinates with optional double-click and navigation guard. */
export async function clickCoordsViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    x: number;
    y: number;
    doubleClick?: boolean;
    button?: "left" | "right" | "middle";
    delayMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  await awaitNavigationGuardedInteraction(
    {
      action: async () => {
        await page.mouse.click(opts.x, opts.y, {
          button: opts.button,
          clickCount: opts.doubleClick ? 2 : 1,
          delay: resolveBoundedDelayMs(opts.delayMs, "clickCoords delayMs", ACT_MAX_CLICK_DELAY_MS),
        });
      },
      cdpUrl: opts.cdpUrl,
      page,
      ...interactionNavigationPolicy(opts),
      targetId: opts.targetId,
    },
    abortPromise,
    opts.signal,
    reconcileRemoteDialog,
  ).finally(cleanup);
}

/** Hovers a role ref or selector on the target page. */
export async function hoverViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    ref?: string;
    selector?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector!;
  const locator = resolved.ref
    ? refLocator(page, requireRef(resolved.ref))
    : page.locator(resolved.selector!);
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await awaitNavigationGuardedInteraction(
      {
        action: async () =>
          await locator.hover({
            timeout: resolveInteractionTimeoutMs(opts.timeoutMs),
          }),
        cdpUrl: opts.cdpUrl,
        page,
        ...interactionNavigationPolicy(opts),
        targetId: opts.targetId,
      },
      abortPromise,
      opts.signal,
      reconcileRemoteDialog,
    );
  } catch (err) {
    throw toFriendlyInteractionError(err, label);
  } finally {
    cleanup();
  }
}

/** Drags from one role ref or selector to another. */
export async function dragViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    startRef?: string;
    startSelector?: string;
    endRef?: string;
    endSelector?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const resolvedStart = requireRefOrSelector(opts.startRef, opts.startSelector);
  const resolvedEnd = requireRefOrSelector(opts.endRef, opts.endSelector);
  const page = await getRestoredPageForTarget(opts);
  const startLocator = resolvedStart.ref
    ? refLocator(page, requireRef(resolvedStart.ref))
    : page.locator(resolvedStart.selector!);
  const endLocator = resolvedEnd.ref
    ? refLocator(page, requireRef(resolvedEnd.ref))
    : page.locator(resolvedEnd.selector!);
  const startLabel = resolvedStart.ref ?? resolvedStart.selector!;
  const endLabel = resolvedEnd.ref ?? resolvedEnd.selector!;
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await awaitNavigationGuardedInteraction(
      {
        action: async () =>
          await startLocator.dragTo(endLocator, {
            timeout: resolveInteractionTimeoutMs(opts.timeoutMs),
          }),
        cdpUrl: opts.cdpUrl,
        page,
        ...interactionNavigationPolicy(opts),
        targetId: opts.targetId,
      },
      abortPromise,
      opts.signal,
      reconcileRemoteDialog,
    );
  } catch (err) {
    throw toFriendlyInteractionError(err, `${startLabel} -> ${endLabel}`);
  } finally {
    cleanup();
  }
}

/** Selects one or more option values on a select-like element. */
export async function selectOptionViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    ref?: string;
    selector?: string;
    values: string[];
    timeoutMs?: number;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  if (!opts.values?.length) {
    throw new Error("values are required");
  }
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector!;
  const locator = resolved.ref
    ? refLocator(page, requireRef(resolved.ref))
    : page.locator(resolved.selector!);
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await awaitNavigationGuardedInteraction(
      {
        action: async () => {
          await locator.selectOption(opts.values, {
            timeout: resolveInteractionTimeoutMs(opts.timeoutMs),
          });
        },
        cdpUrl: opts.cdpUrl,
        page,
        ...interactionNavigationPolicy(opts),
        targetId: opts.targetId,
      },
      abortPromise,
      opts.signal,
      reconcileRemoteDialog,
    );
  } catch (err) {
    throw toFriendlyInteractionError(err, label);
  } finally {
    cleanup();
  }
}

/** Presses a keyboard key against a ref, selector, or focused page. */
export async function pressKeyViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    key: string;
    delayMs?: number;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const key = normalizeOptionalString(opts.key) ?? "";
  if (!key) {
    throw new Error("key is required");
  }
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await awaitNavigationGuardedInteraction(
      {
        action: async () => {
          await page.keyboard.press(key, {
            delay: resolveNonNegativeIntegerOption(opts.delayMs, 0),
          });
        },
        cdpUrl: opts.cdpUrl,
        page,
        ...interactionNavigationPolicy(opts),
        targetId: opts.targetId,
      },
      abortPromise,
      opts.signal,
      reconcileRemoteDialog,
    );
  } finally {
    cleanup();
  }
}

/** Types text into a ref, selector, or focused page. */
export async function typeViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    ref?: string;
    selector?: string;
    text: string;
    submit?: boolean;
    slowly?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const text = opts.text ?? "";
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector!;
  const locator = resolved.ref
    ? refLocator(page, requireRef(resolved.ref))
    : page.locator(resolved.selector!);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await awaitNavigationGuardedInteraction(
      {
        action: async () => {
          if (opts.slowly) {
            await locator.click({ timeout });
            throwIfInteractionAborted(opts.signal);
            await locator.type(text, { timeout, delay: 75 });
          } else {
            await locator.fill(text, { timeout });
          }
          if (opts.submit) {
            throwIfInteractionAborted(opts.signal);
            await locator.press("Enter", { timeout });
          }
        },
        cdpUrl: opts.cdpUrl,
        page,
        ...interactionNavigationPolicy(opts),
        targetId: opts.targetId,
      },
      abortPromise,
      opts.signal,
      reconcileRemoteDialog,
    );
  } catch (err) {
    throw toFriendlyInteractionError(err, label);
  } finally {
    cleanup();
  }
}

/** Fills multiple form fields with per-field selector/ref/type support. */
export async function fillFormViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    fields: BrowserFormField[];
    timeoutMs?: number;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    for (const field of opts.fields) {
      const ref = field.ref.trim();
      if (!ref) {
        continue;
      }
      const type = (field.type || DEFAULT_FILL_FIELD_TYPE).trim() || DEFAULT_FILL_FIELD_TYPE;
      const rawValue = field.value;
      const value =
        typeof rawValue === "string"
          ? rawValue
          : typeof rawValue === "number" || typeof rawValue === "boolean"
            ? String(rawValue)
            : "";
      const locator = refLocator(page, ref);
      try {
        await awaitNavigationGuardedInteraction(
          {
            action: async () => {
              if (type === "checkbox" || type === "radio") {
                const checked =
                  rawValue === true || rawValue === 1 || rawValue === "1" || rawValue === "true";
                await locator.setChecked(checked, { timeout });
              } else {
                await locator.fill(value, { timeout });
              }
            },
            cdpUrl: opts.cdpUrl,
            page,
            ...interactionNavigationPolicy(opts),
            targetId: opts.targetId,
          },
          abortPromise,
          opts.signal,
          reconcileRemoteDialog,
        );
      } catch (err) {
        throw toFriendlyInteractionError(err, ref);
      }
    }
  } finally {
    cleanup();
  }
}

/** Evaluates JavaScript in the page after browser action policy validation. */
export async function evaluateViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    fn: string;
    ref?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<unknown> {
  const fnText = normalizeOptionalString(opts.fn) ?? "";
  if (!fnText) {
    throw new Error("function is required");
  }
  const fnSource = normalizeBrowserEvaluateFunctionSource(
    fnText,
    opts.ref ? { argumentName: "el" } : undefined,
  );
  const page = await getRestoredPageForTarget(opts);
  // Clamp evaluate timeout to prevent permanently blocking Playwright's command queue.
  // Without this, a long-running async evaluate blocks all subsequent page operations
  // because Playwright serializes CDP commands per page.
  //
  // NOTE: Playwright's { timeout } on evaluate only applies to installing the function,
  // NOT to its execution time. We must inject a Promise.race timeout into the browser
  // context itself so async functions are bounded.
  const outerTimeout = normalizeTimeoutMs(opts.timeoutMs, 20_000);
  // Leave headroom for routing/serialization overhead so the outer request timeout
  // doesn't fire first and strand a long-running evaluate.
  let evaluateTimeout = Math.max(1000, Math.min(120_000, outerTimeout - 500));
  evaluateTimeout = Math.min(evaluateTimeout, outerTimeout);

  const signal = opts.signal;
  const { abortPromise, cleanup } = createAbortPromiseWithListener(signal, (reason) => {
    if (isBrowserObservedDialogBlockedError(reason)) {
      return;
    }
    void forceDisconnectPlaywrightForTarget({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      ssrfPolicy: opts.ssrfPolicy,
      reason: "evaluate aborted",
    }).catch(() => {});
  });
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }

  try {
    const navigationPolicy = interactionNavigationPolicy(opts);
    const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, signal);

    if (opts.ref) {
      const locator = refLocator(page, opts.ref);
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- required for browser-context eval
      const elementEvaluator = new Function(
        "el",
        "args",
        `
        "use strict";
        var fnSource = args.fnSource, timeoutMs = args.timeoutMs;
        try {
          var candidate = eval("(" + fnSource + ")");
          if (typeof candidate !== "function") {
            throw new Error("evaluate source did not produce a function");
          }
          var result = candidate(el);
          if (result && typeof result.then === "function") {
            return Promise.race([
              result,
              new Promise(function(_, reject) {
                setTimeout(function() { reject(new Error("evaluate timed out after " + timeoutMs + "ms")); }, timeoutMs);
              })
            ]);
          }
          return result;
        } catch (err) {
          throw new Error("Invalid evaluate function: " + (err && err.message ? err.message : String(err)));
        }
        `,
      ) as (el: Element, args: { fnSource: string; timeoutMs: number }) => unknown;
      return await awaitNavigationGuardedInteraction(
        {
          action: async () =>
            await locator.evaluate(elementEvaluator, {
              fnSource,
              timeoutMs: evaluateTimeout,
            }),
          cdpUrl: opts.cdpUrl,
          page,
          ...navigationPolicy,
          targetId: opts.targetId,
        },
        abortPromise,
        signal,
        reconcileRemoteDialog,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- required for browser-context eval
    const browserEvaluator = new Function(
      "args",
      `
        "use strict";
        var fnSource = args.fnSource, timeoutMs = args.timeoutMs;
        try {
          var candidate = eval("(" + fnSource + ")");
          if (typeof candidate !== "function") {
            throw new Error("evaluate source did not produce a function");
          }
          var result = candidate();
          if (result && typeof result.then === "function") {
            return Promise.race([
              result,
              new Promise(function(_, reject) {
                setTimeout(function() { reject(new Error("evaluate timed out after " + timeoutMs + "ms")); }, timeoutMs);
              })
            ]);
          }
          return result;
        } catch (err) {
          throw new Error("Invalid evaluate function: " + (err && err.message ? err.message : String(err)));
        }
      `,
    ) as (args: { fnSource: string; timeoutMs: number }) => unknown;
    return await awaitNavigationGuardedInteraction(
      {
        action: async () =>
          await page.evaluate(browserEvaluator, {
            fnSource,
            timeoutMs: evaluateTimeout,
          }),
        cdpUrl: opts.cdpUrl,
        page,
        ...navigationPolicy,
        targetId: opts.targetId,
      },
      abortPromise,
      signal,
      reconcileRemoteDialog,
    );
  } finally {
    cleanup();
  }
}

/** Scrolls a role ref or selector into view. */
export async function scrollIntoViewViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    ref?: string;
    selector?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = await getRestoredPageForTarget(opts);
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 20_000);

  const label = resolved.ref ?? resolved.selector!;
  const locator = resolved.ref
    ? refLocator(page, requireRef(resolved.ref))
    : page.locator(resolved.selector!);
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await awaitNavigationGuardedInteraction(
      {
        action: async () => await locator.scrollIntoViewIfNeeded({ timeout }),
        cdpUrl: opts.cdpUrl,
        page,
        ...interactionNavigationPolicy(opts),
        targetId: opts.targetId,
      },
      abortPromise,
      opts.signal,
      reconcileRemoteDialog,
    );
  } catch (err) {
    throw toFriendlyInteractionError(err, label);
  } finally {
    cleanup();
  }
}

/** Waits for load state, timeout, URL, text, ref, or selector conditions. */
export async function waitForViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  timeMs?: number;
  text?: string;
  textGone?: string;
  selector?: string;
  url?: string;
  loadState?: "load" | "domcontentloaded" | "networkidle";
  fn?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const timeout = resolveActWaitTimeoutMs(opts.timeoutMs);
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  const waitForStep = async <T>(stepPromise: Promise<T>) => {
    await awaitActionWithAbort(stepPromise, abortPromise, reconcileRemoteDialog);
  };

  try {
    // Playwright exposes no per-wait cancellation; retiring the shared
    // connection would disrupt sibling tabs. Keep waits outside this guard.
    if (typeof opts.timeMs === "number" && Number.isFinite(opts.timeMs)) {
      await waitForStep(
        page.waitForTimeout(
          resolveBoundedDelayMs(opts.timeMs, "wait timeMs", ACT_MAX_WAIT_TIME_MS),
        ),
      );
    }
    if (opts.text) {
      await waitForStep(
        page.getByText(opts.text).first().waitFor({
          state: "visible",
          timeout,
        }),
      );
    }
    if (opts.textGone) {
      await waitForStep(
        page.getByText(opts.textGone).first().waitFor({
          state: "hidden",
          timeout,
        }),
      );
    }
    if (opts.selector) {
      const selector = normalizeOptionalString(opts.selector) ?? "";
      if (selector) {
        await waitForStep(page.locator(selector).first().waitFor({ state: "visible", timeout }));
      }
    }
    if (opts.url) {
      const url = normalizeOptionalString(opts.url) ?? "";
      if (url) {
        await waitForStep(page.waitForURL(url, { timeout }));
      }
    }
    if (opts.loadState) {
      await waitForStep(page.waitForLoadState(opts.loadState, { timeout }));
    }
    if (opts.fn) {
      const fn = normalizeOptionalString(opts.fn) ?? "";
      if (fn) {
        await waitForStep(page.waitForFunction(fn, { timeout }));
      }
    }
  } finally {
    cleanup();
  }
}

/** Captures a screenshot from the target page or element. */
export async function takeScreenshotViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  element?: string;
  fullPage?: boolean;
  type?: "png" | "jpeg";
  timeoutMs?: number;
}): Promise<{ buffer: Buffer }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  const type = opts.type ?? "png";
  if (opts.ref) {
    if (opts.fullPage) {
      throw new Error("fullPage is not supported for element screenshots");
    }
    const locator = refLocator(page, opts.ref);
    const buffer = await locator.screenshot({ type, timeout: opts.timeoutMs });
    return { buffer };
  }
  if (opts.element) {
    if (opts.fullPage) {
      throw new Error("fullPage is not supported for element screenshots");
    }
    const locator = page.locator(opts.element).first();
    const buffer = await locator.screenshot({ type, timeout: opts.timeoutMs });
    return { buffer };
  }
  const buffer = await page.screenshot({
    type,
    fullPage: Boolean(opts.fullPage),
    timeout: opts.timeoutMs,
  });
  return { buffer };
}

/** Captures a screenshot with Browser plugin labels over interactive elements. */
export async function screenshotWithLabelsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  refs: Record<string, { role: string; name?: string; nth?: number }>;
  maxLabels?: number;
  type?: "png" | "jpeg";
  timeoutMs?: number;
  fullPage?: boolean;
  ref?: string;
  element?: string;
}): Promise<{
  buffer: Buffer;
  labels: number;
  skipped: number;
  annotations: AnnotationItem[];
}> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  const type = opts.type ?? "png";
  const maxLabels =
    typeof opts.maxLabels === "number" && Number.isFinite(opts.maxLabels)
      ? Math.max(1, Math.floor(opts.maxLabels))
      : ANNOTATION_MAX_LABELS_DEFAULT;

  const refKey = normalizeOptionalString(opts.ref) ?? undefined;
  const elementSelector = normalizeOptionalString(opts.element) ?? undefined;
  const space: CoordinateSpace = opts.fullPage
    ? "fullpage"
    : refKey || elementSelector
      ? "element"
      : "viewport";

  // Read scroll + viewport size. Scroll converts Playwright's viewport-space
  // boundingBoxes into document-space inputs; the viewport size lets the helper
  // restore the shipped `labelsSkipped` semantics by counting off-viewport refs
  // as skipped (in viewport capture mode).
  const view = await page.evaluate(() => ({
    x: window.scrollX || 0,
    y: window.scrollY || 0,
    width: window.innerWidth || 0,
    height: window.innerHeight || 0,
  }));
  const scroll = { x: view.x, y: view.y };

  let elementRect: { x: number; y: number; width: number; height: number } | undefined;
  if (space === "element") {
    const box = await resolveElementBoundingBoxForLabels(page, refKey, elementSelector);
    if (!box) {
      throw new Error(
        `screenshotWithLabelsViaPlaywright: element not found for ${
          refKey ? `ref="${refKey}"` : `selector="${elementSelector ?? ""}"`
        }`,
      );
    }
    // Convert viewport-space bbox to document space.
    elementRect = {
      x: box.x + scroll.x,
      y: box.y + scroll.y,
      width: box.width,
      height: box.height,
    };
  }

  const refKeys = Object.keys(opts.refs ?? {});
  const inputs: RawAnnotationInput[] = [];
  let bboxFailures = 0;
  for (const ref of refKeys) {
    const refInfo = opts.refs[ref];
    if (refInfo === undefined) {
      continue;
    }
    const box = await refLocator(page, ref)
      .boundingBox()
      .catch(() => null);
    if (!box) {
      bboxFailures += 1;
      continue;
    }
    inputs.push({
      ref,
      role: refInfo.role,
      name: refInfo.name,
      doc: {
        x: box.x + scroll.x,
        y: box.y + scroll.y,
        width: box.width,
        height: box.height,
      },
    });
  }

  const plan = planAnnotations({
    inputs,
    space,
    scroll,
    viewport: { width: view.width, height: view.height },
    elementRect,
    maxLabels,
  });

  try {
    if (plan.overlayItems.length > 0) {
      const captureY = space === "element" ? elementRect?.y : space === "viewport" ? scroll.y : 0;
      await page.evaluate(buildOverlayInjectionScript({ items: plan.overlayItems, captureY }));
    }
    const buffer =
      space === "element"
        ? await captureElementScreenshotForLabels(
            page,
            refKey,
            elementSelector,
            type,
            opts.timeoutMs,
          )
        : await page.screenshot({
            type,
            fullPage: Boolean(opts.fullPage),
            timeout: opts.timeoutMs,
          });
    return {
      // `labels` reports overlay boxes actually drawn on the captured image
      // (in-viewport, within budget); off-viewport refs are surfaced via
      // `annotations` but not drawn, and are reflected in `skipped`.
      buffer,
      labels: plan.overlayItems.length,
      skipped: plan.skipped + bboxFailures,
      annotations: plan.annotations,
    };
  } finally {
    await page.evaluate(buildOverlayClearScript()).catch(() => {});
  }
}

async function resolveElementBoundingBoxForLabels(
  page: Page,
  refKey: string | undefined,
  cssSelector: string | undefined,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  if (refKey) {
    try {
      return await refLocator(page, refKey).boundingBox();
    } catch {
      return null;
    }
  }
  if (cssSelector) {
    try {
      return await page.locator(cssSelector).first().boundingBox();
    } catch {
      return null;
    }
  }
  return null;
}

async function captureElementScreenshotForLabels(
  page: Page,
  refKey: string | undefined,
  cssSelector: string | undefined,
  type: "png" | "jpeg",
  timeoutMs: number | undefined,
): Promise<Buffer> {
  if (refKey) {
    return await refLocator(page, refKey).screenshot({ type, timeout: timeoutMs });
  }
  if (cssSelector) {
    return await page.locator(cssSelector).first().screenshot({ type, timeout: timeoutMs });
  }
  throw new Error("captureElementScreenshotForLabels: requires refKey or cssSelector");
}

/** Sets file inputs for a role ref or selector with strict existing-path checks. */
export async function setFileChooserFilesViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    page: Page;
    fileChooser: FileChooser;
    paths: string[];
    timeoutMs: number;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  await awaitNavigationGuardedInteraction({
    action: async () => {
      await opts.fileChooser.setFiles(opts.paths, { timeout: opts.timeoutMs });
    },
    cdpUrl: opts.cdpUrl,
    page: opts.page,
    ...interactionNavigationPolicy(opts),
    targetId: opts.targetId,
  });
}

export async function setInputFilesViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    inputRef?: string;
    element?: string;
    paths: string[];
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  if (!opts.paths.length) {
    throw new Error("paths are required");
  }
  const inputRef = normalizeOptionalString(opts.inputRef) ?? "";
  const element = normalizeOptionalString(opts.element) ?? "";
  if (inputRef && element) {
    throw new Error("inputRef and element are mutually exclusive");
  }
  if (!inputRef && !element) {
    throw new Error("inputRef or element is required");
  }

  const locator = inputRef ? refLocator(page, inputRef) : page.locator(element).first();
  const resolvedResult = await resolveStrictExistingUploadPaths({ requestedPaths: opts.paths });
  if (!resolvedResult.ok) {
    throw new Error(resolvedResult.error);
  }
  const resolvedPaths = resolvedResult.paths;

  try {
    await awaitNavigationGuardedInteraction({
      action: async () => {
        await locator.setInputFiles(resolvedPaths);
      },
      cdpUrl: opts.cdpUrl,
      page,
      ...interactionNavigationPolicy(opts),
      targetId: opts.targetId,
    });
  } catch (err) {
    throw toFriendlyInteractionError(err, inputRef || element);
  }
}

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
        timeoutMs: action.timeoutMs,
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
  switch (action.kind) {
    case "close":
    case "resize":
    case "wait":
      return false;
    case "batch":
      return action.actions.some(actionUsesNavigationRequestGuard);
    default:
      return true;
  }
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

/** Executes one high-level browser act request with bounded recursive actions. */
export async function executeActViaPlaywright(
  opts: {
    cdpUrl: string;
    action: BrowserActRequest;
    targetId?: string;
    evaluateEnabled?: boolean;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<{
  result?: unknown;
  results?: Array<{ ok: boolean; error?: string }>;
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
        ...navigationPolicy,
        actions: opts.action.actions,
        stopOnError: opts.action.stopOnError,
        evaluateEnabled: opts.evaluateEnabled,
        signal: dialogAbort.signal,
      });
      const newDownloads = await drainDownloads();
      return {
        results: batch.results,
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

/** Executes a bounded sequence of browser actions and returns per-step results. */
export async function batchViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    actions: BrowserActRequest[];
    stopOnError?: boolean;
    evaluateEnabled?: boolean;
    depth?: number;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<{ results: Array<{ ok: boolean; error?: string }> }> {
  const navigationPolicy = interactionNavigationPolicy(opts);
  const depth = opts.depth ?? 0;
  if (depth > ACT_MAX_BATCH_DEPTH) {
    throw new Error(`Batch nesting depth exceeds maximum of ${ACT_MAX_BATCH_DEPTH}`);
  }
  if (opts.actions.length > ACT_MAX_BATCH_ACTIONS) {
    throw new Error(`Batch exceeds maximum of ${ACT_MAX_BATCH_ACTIONS} actions`);
  }
  const results: Array<{ ok: boolean; error?: string }> = [];
  for (const action of opts.actions) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason ?? new Error("aborted");
    }
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
    } catch (err) {
      if (isBrowserObservedDialogBlockedError(err)) {
        throw err;
      }
      if (isPolicyDenyNavigationError(err)) {
        throw err;
      }
      const message = formatErrorMessage(err);
      results.push({ ok: false, error: message });
      if (opts.stopOnError !== false) {
        break;
      }
    }
  }
  return { results };
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
