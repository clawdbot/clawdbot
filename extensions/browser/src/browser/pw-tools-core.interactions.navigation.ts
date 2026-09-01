import type { Frame, Page } from "playwright-core";
import { toErrorObject } from "../infra/errors.js";
import { BROWSER_ACTION_NAVIGATION_GRACE_MS } from "./act-policy.js";
import {
  assertBrowserNavigationResultAllowed,
  type BrowserNavigationPolicyOptions,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import {
  assertPageNavigationCompletedSafely,
  ensurePageState,
  getPageForTargetId,
  isBrowserObservedDialogBlockedError,
  isPolicyDenyNavigationError,
  markObservedDialogsHandledRemotelyForPage,
  quarantineBlockedNavigationTarget,
  restoreRoleRefsForTarget,
  wasBrowserNavigationSourcePreservedAfterPolicyDenial,
  withPageNavigationRequestGuard,
} from "./pw-session.js";
import { toAIFriendlyError } from "./pw-tools-core.shared.js";

export type InteractionTargetOptions = {
  cdpUrl: string;
  browserFilesystemLocal?: boolean;
  targetId?: string;
};

export type NavigationTargetOptions = InteractionTargetOptions & BrowserNavigationPolicyOptions;
export type GuardedInteractionOptions = NavigationTargetOptions & { signal?: AbortSignal };
export type ElementInteractionOptions = GuardedInteractionOptions & {
  ref?: string;
  selector?: string;
  timeoutMs?: number;
};

export function interactionNavigationPolicy(
  opts: BrowserNavigationPolicyOptions,
): BrowserNavigationPolicyOptions {
  return withBrowserNavigationPolicy(opts.ssrfPolicy, {
    browserProxyMode: opts.browserProxyMode,
  });
}

export function hasInteractionNavigationPolicy(policy: BrowserNavigationPolicyOptions): boolean {
  return Boolean(policy.ssrfPolicy || policy.browserProxyMode);
}

type NavigationObservablePage = Pick<Page, "url"> & {
  mainFrame?: () => Frame;
  on?: (event: "framenavigated", listener: (frame: Frame) => void) => unknown;
  off?: (event: "framenavigated", listener: (frame: Frame) => void) => unknown;
};

const pendingInteractionNavigationGuardCleanup = new WeakMap<Page, () => void>();

export function resolveBoundedDelayMs(
  value: number | undefined,
  label: string,
  maxMs: number,
): number {
  const normalized = Math.floor(value ?? 0);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`${label} must be >= 0`);
  }
  if (normalized > maxMs) {
    throw new Error(`${label} exceeds maximum of ${maxMs}ms`);
  }
  return normalized;
}

export async function getRestoredPageForTarget(opts: InteractionTargetOptions) {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  return page;
}

export function toFriendlyInteractionError(err: unknown, label: string): Error {
  return isBrowserObservedDialogBlockedError(err) ? err : toAIFriendlyError(err, label);
}

export function reconcileRemoteDialogAfterActionSettled(page: Page, signal?: AbortSignal): void {
  if (isBrowserObservedDialogBlockedError(signal?.reason)) {
    markObservedDialogsHandledRemotelyForPage(page);
  }
}

export function throwIfInteractionAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw toErrorObject(signal.reason ?? new Error("aborted"), "Non-Error rejection");
  }
}

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
    throw toErrorObject(subframeError, "Non-Error thrown");
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
        reject(toErrorObject(err, "Non-Error rejection"));
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
    throw toErrorObject(subframeError, "Non-Error thrown");
  }

  if (actionError) {
    throw toErrorObject(actionError, "Non-Error thrown");
  }
  return result as T;
}

export async function awaitActionWithAbort<T>(
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

export async function awaitNavigationGuardedInteraction<T>(
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
      throw toErrorObject(observedPolicyError, "Non-Error thrown");
    }
    throw err;
  }
}

export function createAbortPromiseWithListener(
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
          toErrorObject(signal.reason ?? new Error("aborted"), "Non-Error rejection"),
        );
      })()
    : new Promise((_, reject) => {
        abortListener = () => {
          onAbort?.(signal.reason);
          reject(toErrorObject(signal.reason ?? new Error("aborted"), "Non-Error rejection"));
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
