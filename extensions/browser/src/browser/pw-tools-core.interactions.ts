import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Frame, Page } from "playwright-core";
import { formatErrorMessage } from "../infra/errors.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import {
  ACT_MAX_BATCH_ACTIONS,
  ACT_MAX_BATCH_DEPTH,
  ACT_MAX_CLICK_DELAY_MS,
  ACT_MAX_WAIT_TIME_MS,
  resolveActInteractionTimeoutMs,
  resolveActWaitTimeoutMs,
} from "./act-policy.js";
import type { BrowserActRequest, BrowserFormField } from "./client-actions.types.js";
import { DEFAULT_FILL_FIELD_TYPE } from "./form-fields.js";
import {
  assertBrowserNavigationResultAllowed,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import { DEFAULT_UPLOAD_DIR, resolveStrictExistingPathsWithinRoot } from "./paths.js";
import {
  assertPageNavigationCompletedSafely,
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  refLocator,
  restoreRoleRefsForTarget,
} from "./pw-session.js";
import {
  normalizeTimeoutMs,
  requireRef,
  requireRefOrSelector,
  toAIFriendlyError,
} from "./pw-tools-core.shared.js";
import { closePageViaPlaywright, resizeViewportViaPlaywright } from "./pw-tools-core.snapshot.js";

type TargetOpts = {
  cdpUrl: string;
  targetId?: string;
};

const INTERACTION_NAVIGATION_GRACE_MS = 250;

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
  ssrfPolicy?: SsrFPolicy,
): Promise<void> {
  if (!ssrfPolicy || (!frameUrl.startsWith("http://") && !frameUrl.startsWith("https://"))) {
    // Non-network frame URLs like about:blank and about:srcdoc do not cross the
    // browser SSRF boundary, so they should not trigger the navigation policy.
    return;
  }

  await assertBrowserNavigationResultAllowed({
    url: frameUrl,
    ...withBrowserNavigationPolicy(ssrfPolicy),
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

async function assertObservedDelayedNavigations(opts: {
  cdpUrl: string;
  page: Page;
  ssrfPolicy?: SsrFPolicy;
  targetId?: string;
  observed: ObservedDelayedNavigations;
}): Promise<void> {
  let subframeError: unknown;
  try {
    for (const frameUrl of opts.observed.subframes) {
      await assertSubframeNavigationAllowed(frameUrl, opts.ssrfPolicy);
    }
  } catch (err) {
    subframeError = err;
  }
  if (opts.observed.mainFrameNavigated) {
    await assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      response: null,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  }
  if (subframeError) {
    throw subframeError;
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
    }, INTERACTION_NAVIGATION_GRACE_MS);
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

function scheduleDelayedInteractionNavigationGuard(opts: {
  cdpUrl: string;
  page: Page;
  previousUrl: string;
  ssrfPolicy?: SsrFPolicy;
  targetId?: string;
}): Promise<void> {
  if (!opts.ssrfPolicy) {
    return Promise.resolve();
  }
  const page = opts.page as unknown as NavigationObservablePage;
  if (didCrossDocumentUrlChange(page, opts.previousUrl)) {
    return assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      response: null,
      ssrfPolicy: opts.ssrfPolicy,
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
        reject(err);
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
        ssrfPolicy: opts.ssrfPolicy,
        targetId: opts.targetId,
        observed: { mainFrameNavigated: true, subframes },
      }).then(() => settle(), settle);
    };
    const timeout = setTimeout(() => {
      cleanup();
      void assertObservedDelayedNavigations({
        cdpUrl: opts.cdpUrl,
        page: opts.page,
        ssrfPolicy: opts.ssrfPolicy,
        targetId: opts.targetId,
        observed: {
          mainFrameNavigated: didCrossDocumentUrlChange(page, opts.previousUrl),
          subframes,
        },
      }).then(() => settle(), settle);
    }, INTERACTION_NAVIGATION_GRACE_MS);
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

async function assertInteractionNavigationCompletedSafely<T>(opts: {
  action: () => Promise<T>;
  cdpUrl: string;
  page: Page;
  previousUrl: string;
  ssrfPolicy?: SsrFPolicy;
  targetId?: string;
}): Promise<T> {
  if (!opts.ssrfPolicy) {
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
      await assertSubframeNavigationAllowed(frameUrl, opts.ssrfPolicy);
    }
  } catch (err) {
    subframeError = err;
  }

  if (navigationObserved) {
    await assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      response: null,
      ssrfPolicy: opts.ssrfPolicy,
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
        ssrfPolicy: opts.ssrfPolicy,
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
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  }

  if (subframeError) {
    throw subframeError;
  }

  if (actionError) {
    throw actionError;
  }
  return result as T;
}

async function awaitActionWithAbort<T>(
  actionPromise: Promise<T>,
  abortPromise?: Promise<never>,
): Promise<T> {
  if (!abortPromise) {
    return await actionPromise;
  }
  try {
    return await Promise.race([actionPromise, abortPromise]);
  } catch (err) {
    // If abort wins the race, the action may reject later; avoid unhandled rejections.
    void actionPromise.catch(() => {});
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
  onAbort?: () => void,
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
        onAbort?.();
        return Promise.reject(signal.reason ?? new Error("aborted"));
      })()
    : new Promise((_, reject) => {
        abortListener = () => {
          onAbort?.();
          reject(signal.reason ?? new Error("aborted"));
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
    throw toAIFriendlyError(err, ref);
  }
}

export async function clickViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  selector?: string;
  doubleClick?: boolean;
  button?: "left" | "right" | "middle";
  modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
  delayMs?: number;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  signal?: AbortSignal;
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector!;
  const locator = resolved.ref
    ? refLocator(page, requireRef(resolved.ref))
    : page.locator(resolved.selector!);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);
  const previousUrl = page.url();
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
      void forceDisconnectPlaywrightForTarget({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
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
  try {
    await assertInteractionNavigationCompletedSafely({
      action: async () => {
        const delayMs = resolveBoundedDelayMs(
          opts.delayMs,
          "click delayMs",
          ACT_MAX_CLICK_DELAY_MS,
        );
        if (delayMs > 0) {
          await awaitActionWithAbort(locator.hover({ timeout }), abortPromise);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        if (opts.doubleClick) {
          await awaitActionWithAbort(
            locator.dblclick({
              timeout,
              button: opts.button,
              modifiers: opts.modifiers,
            }),
            abortPromise,
          );
          return;
        }
        await awaitActionWithAbort(
          locator.click({
            timeout,
            button: opts.button,
            modifiers: opts.modifiers,
          }),
          abortPromise,
        );
      },
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  } catch (err) {
    throw toAIFriendlyError(err, label);
  } finally {
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

export async function clickCoordsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  x: number;
  y: number;
  doubleClick?: boolean;
  button?: "left" | "right" | "middle";
  delayMs?: number;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
}): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const previousUrl = page.url();
  await assertInteractionNavigationCompletedSafely({
    action: async () => {
      await page.mouse.click(opts.x, opts.y, {
        button: opts.button,
        clickCount: opts.doubleClick ? 2 : 1,
        delay: resolveBoundedDelayMs(opts.delayMs, "clickCoords delayMs", ACT_MAX_CLICK_DELAY_MS),
      });
    },
    cdpUrl: opts.cdpUrl,
    page,
    previousUrl,
    ssrfPolicy: opts.ssrfPolicy,
    targetId: opts.targetId,
  });
}

export async function hoverViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  selector?: string;
  timeoutMs?: number;
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector!;
  const locator = resolved.ref
    ? refLocator(page, requireRef(resolved.ref))
    : page.locator(resolved.selector!);
  try {
    await locator.hover({
      timeout: resolveInteractionTimeoutMs(opts.timeoutMs),
    });
  } catch (err) {
    throw toAIFriendlyError(err, label);
  }
}

export async function dragViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  startRef?: string;
  startSelector?: string;
  endRef?: string;
  endSelector?: string;
  timeoutMs?: number;
}): Promise<void> {
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
  try {
    await startLocator.dragTo(endLocator, {
      timeout: resolveInteractionTimeoutMs(opts.timeoutMs),
    });
  } catch (err) {
    throw toAIFriendlyError(err, `${startLabel} -> ${endLabel}`);
  }
}

export async function selectOptionViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  selector?: string;
  values: string[];
  timeoutMs?: number;
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  if (!opts.values?.length) {
    throw new Error("values are required");
  }
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector!;
  const locator = resolved.ref
    ? refLocator(page, requireRef(resolved.ref))
    : page.locator(resolved.selector!);
  try {
    await locator.selectOption(opts.values, {
      timeout: resolveInteractionTimeoutMs(opts.timeoutMs),
    });
  } catch (err) {
    throw toAIFriendlyError(err, label);
  }
}

export async function pressKeyViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  key: string;
  delayMs?: number;
  ssrfPolicy?: SsrFPolicy;
}): Promise<void> {
  const key = normalizeOptionalString(opts.key) ?? "";
  if (!key) {
    throw new Error("key is required");
  }
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const previousUrl = page.url();
  await assertInteractionNavigationCompletedSafely({
    action: async () => {
      await page.keyboard.press(key, {
        delay: Math.max(0, Math.floor(opts.delayMs ?? 0)),
      });
    },
    cdpUrl: opts.cdpUrl,
    page,
    previousUrl,
    ssrfPolicy: opts.ssrfPolicy,
    targetId: opts.targetId,
  });
}

export async function typeViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  selector?: string;
  text: string;
  submit?: boolean;
  slowly?: boolean;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const text = opts.text ?? "";
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector!;
  const locator = resolved.ref
    ? refLocator(page, requireRef(resolved.ref))
    : page.locator(resolved.selector!);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);
  try {
    if (opts.slowly) {
      await locator.click({ timeout });
      await locator.type(text, { timeout, delay: 75 });
    } else {
      await locator.fill(text, { timeout });
    }
    if (opts.submit) {
      const previousUrl = page.url();
      await assertInteractionNavigationCompletedSafely({
        action: async () => {
          await locator.press("Enter", { timeout });
        },
        cdpUrl: opts.cdpUrl,
        page,
        previousUrl,
        ssrfPolicy: opts.ssrfPolicy,
        targetId: opts.targetId,
      });
    }
  } catch (err) {
    throw toAIFriendlyError(err, label);
  }
}

export async function fillFormViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  fields: BrowserFormField[];
  timeoutMs?: number;
}): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);
  for (const field of opts.fields) {
    const ref = field.ref.trim();
    const type = (field.type || DEFAULT_FILL_FIELD_TYPE).trim() || DEFAULT_FILL_FIELD_TYPE;
    const rawValue = field.value;
    const value =
      typeof rawValue === "string"
        ? rawValue
        : typeof rawValue === "number" || typeof rawValue === "boolean"
          ? String(rawValue)
          : "";
    if (!ref) {
      continue;
    }
    const locator = refLocator(page, ref);
    if (type === "checkbox" || type === "radio") {
      const checked =
        rawValue === true || rawValue === 1 || rawValue === "1" || rawValue === "true";
      try {
        await locator.setChecked(checked, { timeout });
      } catch (err) {
        throw toAIFriendlyError(err, ref);
      }
      continue;
    }
    try {
      await locator.fill(value, { timeout });
    } catch (err) {
      throw toAIFriendlyError(err, ref);
    }
  }
}

export async function evaluateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrFPolicy;
  fn: string;
  ref?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<unknown> {
  const fnText = normalizeOptionalString(opts.fn) ?? "";
  if (!fnText) {
    throw new Error("function is required");
  }
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
  const { abortPromise, cleanup } = createAbortPromiseWithListener(signal, () => {
    void forceDisconnectPlaywrightForTarget({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      reason: "evaluate aborted",
    }).catch(() => {});
  });
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }

  try {
    if (opts.ref) {
      const locator = refLocator(page, opts.ref);
      const previousUrl = page.url();
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- required for browser-context eval
      const elementEvaluator = new Function(
        "el",
        "args",
        `
        "use strict";
        var fnBody = args.fnBody, timeoutMs = args.timeoutMs;
        try {
          var candidate = eval("(" + fnBody + ")");
          var result = typeof candidate === "function" ? candidate(el) : candidate;
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
      ) as (el: Element, args: { fnBody: string; timeoutMs: number }) => unknown;
      const evalPromise = locator.evaluate(elementEvaluator, {
        fnBody: fnText,
        timeoutMs: evaluateTimeout,
      });
      const result = await assertInteractionNavigationCompletedSafely({
        action: () => awaitActionWithAbort(evalPromise, abortPromise),
        cdpUrl: opts.cdpUrl,
        page,
        previousUrl,
        ssrfPolicy: opts.ssrfPolicy,
        targetId: opts.targetId,
      });
      return result;
    }

    const previousUrl = page.url();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- required for browser-context eval
    const browserEvaluator = new Function(
      "args",
      `
        "use strict";
        var fnBody = args.fnBody, timeoutMs = args.timeoutMs;
        try {
          var candidate = eval("(" + fnBody + ")");
          var result = typeof candidate === "function" ? candidate() : candidate;
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
    ) as (args: { fnBody: string; timeoutMs: number }) => unknown;
    const evalPromise = page.evaluate(browserEvaluator, {
      fnBody: fnText,
      timeoutMs: evaluateTimeout,
    });
    const result = await assertInteractionNavigationCompletedSafely({
      action: () => awaitActionWithAbort(evalPromise, abortPromise),
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
    return result;
  } finally {
    cleanup();
  }
}

export async function scrollIntoViewViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  selector?: string;
  timeoutMs?: number;
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = await getRestoredPageForTarget(opts);
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 20_000);

  const label = resolved.ref ?? resolved.selector!;
  const locator = resolved.ref
    ? refLocator(page, requireRef(resolved.ref))
    : page.locator(resolved.selector!);
  try {
    await locator.scrollIntoViewIfNeeded({ timeout });
  } catch (err) {
    throw toAIFriendlyError(err, label);
  }
}

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
  const waitForStep = async <T>(stepPromise: Promise<T>) => {
    await awaitActionWithAbort(stepPromise, abortPromise);
  };

  try {
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

export async function screenshotWithLabelsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  refs: Record<string, { role: string; name?: string; nth?: number }>;
  maxLabels?: number;
  type?: "png" | "jpeg";
  timeoutMs?: number;
}): Promise<{ buffer: Buffer; labels: number; skipped: number }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  const type = opts.type ?? "png";
  const maxLabels =
    typeof opts.maxLabels === "number" && Number.isFinite(opts.maxLabels)
      ? Math.max(1, Math.floor(opts.maxLabels))
      : 150;

  const viewport = await page.evaluate(() => ({
    scrollX: window.scrollX || 0,
    scrollY: window.scrollY || 0,
    width: window.innerWidth || 0,
    height: window.innerHeight || 0,
  }));

  const refs = Object.keys(opts.refs ?? {});
  const boxes: Array<{ ref: string; x: number; y: number; w: number; h: number }> = [];
  let skipped = 0;

  for (const ref of refs) {
    if (boxes.length >= maxLabels) {
      skipped += 1;
      continue;
    }
    try {
      const box = await refLocator(page, ref).boundingBox();
      if (!box) {
        skipped += 1;
        continue;
      }
      const x0 = box.x;
      const y0 = box.y;
      const x1 = box.x + box.width;
      const y1 = box.y + box.height;
      const vx0 = viewport.scrollX;
      const vy0 = viewport.scrollY;
      const vx1 = viewport.scrollX + viewport.width;
      const vy1 = viewport.scrollY + viewport.height;
      if (x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1) {
        skipped += 1;
        continue;
      }
      boxes.push({
        ref,
        x: x0 - viewport.scrollX,
        y: y0 - viewport.scrollY,
        w: Math.max(1, box.width),
        h: Math.max(1, box.height),
      });
    } catch {
      skipped += 1;
    }
  }

  try {
    if (boxes.length > 0) {
      await page.evaluate((labels) => {
        const existing = document.querySelectorAll("[data-openclaw-labels]");
        existing.forEach((el) => el.remove());

        const root = document.createElement("div");
        root.setAttribute("data-openclaw-labels", "1");
        root.style.position = "fixed";
        root.style.left = "0";
        root.style.top = "0";
        root.style.zIndex = "2147483647";
        root.style.pointerEvents = "none";
        root.style.fontFamily =
          '"SF Mono","SFMono-Regular",Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace';

        const clamp = (value: number, min: number, max: number) =>
          Math.min(max, Math.max(min, value));

        for (const label of labels) {
          const box = document.createElement("div");
          box.setAttribute("data-openclaw-labels", "1");
          box.style.position = "absolute";
          box.style.left = `${label.x}px`;
          box.style.top = `${label.y}px`;
          box.style.width = `${label.w}px`;
          box.style.height = `${label.h}px`;
          box.style.border = "2px solid #ffb020";
          box.style.boxSizing = "border-box";

          const tag = document.createElement("div");
          tag.setAttribute("data-openclaw-labels", "1");
          tag.textContent = label.ref;
          tag.style.position = "absolute";
          tag.style.left = `${label.x}px`;
          tag.style.top = `${clamp(label.y - 18, 0, 20000)}px`;
          tag.style.background = "#ffb020";
          tag.style.color = "#1a1a1a";
          tag.style.fontSize = "12px";
          tag.style.lineHeight = "14px";
          tag.style.padding = "1px 4px";
          tag.style.borderRadius = "3px";
          tag.style.boxShadow = "0 1px 2px rgba(0,0,0,0.35)";
          tag.style.whiteSpace = "nowrap";

          root.appendChild(box);
          root.appendChild(tag);
        }

        document.documentElement.appendChild(root);
      }, boxes);
    }

    const buffer = await page.screenshot({ type, timeout: opts.timeoutMs });
    return { buffer, labels: boxes.length, skipped };
  } finally {
    await page
      .evaluate(() => {
        const existing = document.querySelectorAll("[data-openclaw-labels]");
        existing.forEach((el) => el.remove());
      })
      .catch(() => {});
  }
}

export async function setInputFilesViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  inputRef?: string;
  element?: string;
  paths: string[];
}): Promise<void> {
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
  const uploadPathsResult = await resolveStrictExistingPathsWithinRoot({
    rootDir: DEFAULT_UPLOAD_DIR,
    requestedPaths: opts.paths,
    scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`,
  });
  if (!uploadPathsResult.ok) {
    throw new Error(uploadPathsResult.error);
  }
  const resolvedPaths = uploadPathsResult.paths;

  try {
    await locator.setInputFiles(resolvedPaths);
  } catch (err) {
    throw toAIFriendlyError(err, inputRef || element);
  }
  try {
    const handle = await locator.elementHandle();
    if (handle) {
      await handle.evaluate((el) => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
  } catch {
    // Best-effort for sites that don't react to setInputFiles alone.
  }
}

async function executeSingleAction(
  action: BrowserActRequest,
  cdpUrl: string,
  targetId?: string,
  evaluateEnabled?: boolean,
  ssrfPolicy?: SsrFPolicy,
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
        ssrfPolicy,
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
        ssrfPolicy,
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
        ssrfPolicy,
      });
      break;
    case "press":
      await pressKeyViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        key: action.key,
        delayMs: action.delayMs,
        ssrfPolicy,
      });
      break;
    case "hover":
      await hoverViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        timeoutMs: action.timeoutMs,
      });
      break;
    case "scrollIntoView":
      await scrollIntoViewViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        timeoutMs: action.timeoutMs,
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
      });
      break;
    case "fill":
      await fillFormViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        fields: action.fields,
        timeoutMs: action.timeoutMs,
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
        ssrfPolicy,
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
        ssrfPolicy,
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

export async function executeActViaPlaywright(opts: {
  cdpUrl: string;
  action: BrowserActRequest;
  targetId?: string;
  evaluateEnabled?: boolean;
  ssrfPolicy?: SsrFPolicy;
  signal?: AbortSignal;
}): Promise<{
  result?: unknown;
  results?: Array<{ ok: boolean; error?: string }>;
}> {
  if (opts.action.kind === "batch") {
    const batch = await batchViaPlaywright({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      ssrfPolicy: opts.ssrfPolicy,
      actions: opts.action.actions,
      stopOnError: opts.action.stopOnError,
      evaluateEnabled: opts.evaluateEnabled,
      signal: opts.signal,
    });
    return { results: batch.results };
  }
  const result = await executeSingleAction(
    opts.action,
    opts.cdpUrl,
    opts.targetId,
    opts.evaluateEnabled,
    opts.ssrfPolicy,
    0,
    opts.signal,
  );
  if (opts.action.kind === "evaluate") {
    return { result };
  }
  return {};
}

export async function batchViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  actions: BrowserActRequest[];
  stopOnError?: boolean;
  evaluateEnabled?: boolean;
  ssrfPolicy?: SsrFPolicy;
  depth?: number;
  signal?: AbortSignal;
}): Promise<{ results: Array<{ ok: boolean; error?: string }> }> {
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
        opts.ssrfPolicy,
        depth,
        opts.signal,
      );
      results.push({ ok: true });
    } catch (err) {
      const message = formatErrorMessage(err);
      results.push({ ok: false, error: message });
      if (opts.stopOnError !== false) {
        break;
      }
    }
  }
  return { results };
}
