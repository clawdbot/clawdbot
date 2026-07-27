import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { FileChooser, Page } from "playwright-core";
import { ACT_MAX_WAIT_TIME_MS, resolveActWaitTimeoutMs } from "./act-policy.js";
import { normalizeBrowserEvaluateFunctionSource } from "./evaluate-source.js";
import { resolveStrictExistingUploadPaths } from "./paths.js";
import {
  ensurePageState,
  getPageForTargetId,
  refLocator,
  restoreRoleRefsForTarget,
} from "./pw-session.js";
import {
  awaitActionWithAbort,
  awaitNavigationGuardedInteraction,
  createAbortPromiseWithListener,
  type GuardedInteractionOptions,
  type InteractionTargetOptions,
  interactionNavigationPolicy,
  type NavigationTargetOptions,
  reconcileRemoteDialogAfterActionSettled,
  resolveBoundedDelayMs,
  throwIfInteractionAborted,
  toFriendlyInteractionError,
} from "./pw-tools-core.interactions.navigation.js";
import {
  ANNOTATION_MAX_LABELS_DEFAULT,
  type AnnotationItem,
  buildOverlayClearScript,
  buildOverlayInjectionScript,
  type CoordinateSpace,
  planAnnotations,
  type RawAnnotationInput,
} from "./screenshot-annotate.js";

type BrowserWaitPredicateState = {
  document: unknown;
  pending?: boolean;
  predicate?: () => unknown;
  settled?: { kind: "value"; value: unknown } | { error: unknown; kind: "error" };
};

function createBrowserWaitPredicate(source: string): (state: BrowserWaitPredicateState) => boolean {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- compile only; Playwright runs it in-page
  return new Function(
    "state",
    `
      if (state.document !== this.document) throw "Wait predicate document changed";
      state.predicate ??= (${source});
      var settled = state.settled;
      if (settled) {
        delete state.settled;
        if (settled.kind === "error") throw settled.error;
        if (!!settled.value) return true;
      }
      if (state.pending) return false;
      var predicate = state.predicate;
      var value = predicate();
      if (!value || typeof value.then !== "function") return !!value;
      state.pending = true;
      value.then(
        function(resolved) {
          state.settled = { kind: "value", value: resolved };
          delete state.pending;
        },
        function(error) {
          state.settled = { error: error, kind: "error" };
          delete state.pending;
        }
      );
      return false;
    `,
  ) as (state: BrowserWaitPredicateState) => boolean;
}

export async function waitForViaPlaywright(
  opts: GuardedInteractionOptions & {
    timeMs?: number;
    text?: string;
    textGone?: string;
    selector?: string;
    url?: string;
    loadState?: "load" | "domcontentloaded" | "networkidle";
    fn?: string;
    timeoutMs?: number;
  },
): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const timeout = resolveActWaitTimeoutMs(opts.timeoutMs);
  const fn = normalizeOptionalString(opts.fn) ?? "";
  const predicateSource = fn ? normalizeBrowserEvaluateFunctionSource(fn) : "";
  const predicate = fn ? createBrowserWaitPredicate(predicateSource) : undefined;
  const { abortPromise, cleanup } = createAbortPromiseWithListener(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  const waitForStep = async <T>(stepPromise: Promise<T>) => {
    await awaitActionWithAbort(stepPromise, abortPromise, reconcileRemoteDialog);
  };
  const waitForSettledStep = async <T>(stepPromise: Promise<T>) => {
    await stepPromise;
    reconcileRemoteDialog();
    throwIfInteractionAborted(opts.signal);
  };
  const runWaitSequence = async (
    waitFor: <T>(stepPromise: Promise<T>) => Promise<void>,
  ): Promise<void> => {
    if (typeof opts.timeMs === "number" && Number.isFinite(opts.timeMs)) {
      await waitFor(
        page.waitForTimeout(
          resolveBoundedDelayMs(opts.timeMs, "wait timeMs", ACT_MAX_WAIT_TIME_MS),
        ),
      );
    }
    if (opts.text) {
      await waitFor(
        page.getByText(opts.text).first().waitFor({
          state: "visible",
          timeout,
        }),
      );
    }
    if (opts.textGone) {
      await waitFor(
        page.getByText(opts.textGone).first().waitFor({
          state: "hidden",
          timeout,
        }),
      );
    }
    if (opts.selector) {
      const selector = normalizeOptionalString(opts.selector) ?? "";
      if (selector) {
        await waitFor(page.locator(selector).first().waitFor({ state: "visible", timeout }));
      }
    }
    if (opts.url) {
      const url = normalizeOptionalString(opts.url) ?? "";
      if (url) {
        await waitFor(page.waitForURL(url, { timeout }));
      }
    }
    if (opts.loadState) {
      await waitFor(page.waitForLoadState(opts.loadState, { timeout }));
    }
    if (fn) {
      // Passing the live document handle makes Playwright fail instead of
      // recreating this predicate in a replacement execution context.
      const documentHandle = await page.evaluateHandle(() => globalThis.document);
      try {
        throwIfInteractionAborted(opts.signal);
        await waitFor(
          page.waitForFunction(
            predicate!,
            {
              document: documentHandle,
            } satisfies BrowserWaitPredicateState,
            { timeout },
          ),
        );
      } finally {
        await documentHandle.dispose();
      }
    }
  };

  try {
    // Playwright exposes no per-wait cancellation; retiring the shared
    // connection would disrupt sibling tabs. Only executable waits need the
    // request guard, which must own the full sequence before their predicate.
    // `fn` shares the explicit evaluateEnabled trust contract with evaluate;
    // this guard owns navigation during the action, not jobs trusted JS schedules later.
    if (!fn) {
      await runWaitSequence(waitForStep);
      return;
    }
    await awaitNavigationGuardedInteraction(
      {
        action: async () => await runWaitSequence(waitForSettledStep),
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

export async function takeScreenshotViaPlaywright(
  opts: InteractionTargetOptions & {
    ref?: string;
    element?: string;
    fullPage?: boolean;
    type?: "png" | "jpeg";
    timeoutMs?: number;
  },
): Promise<{ buffer: Buffer }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  const type = opts.type ?? "png";
  const elementLocator = opts.ref
    ? refLocator(page, opts.ref)
    : opts.element
      ? page.locator(opts.element).first()
      : undefined;
  if (elementLocator) {
    if (opts.fullPage) {
      throw new Error("fullPage is not supported for element screenshots");
    }
    const buffer = await elementLocator.screenshot({ type, timeout: opts.timeoutMs });
    return { buffer };
  }
  const buffer = await page.screenshot({
    type,
    fullPage: Boolean(opts.fullPage),
    timeout: opts.timeoutMs,
  });
  return { buffer };
}

export async function screenshotWithLabelsViaPlaywright(
  opts: InteractionTargetOptions & {
    refs: Record<string, { role: string; name?: string; nth?: number }>;
    maxLabels?: number;
    type?: "png" | "jpeg";
    timeoutMs?: number;
    fullPage?: boolean;
    ref?: string;
    element?: string;
  },
): Promise<{
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

export async function setFileChooserFilesViaPlaywright(
  opts: NavigationTargetOptions & {
    page: Page;
    fileChooser: FileChooser;
    paths: string[];
    timeoutMs: number;
  },
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
  opts: NavigationTargetOptions & {
    inputRef?: string;
    element?: string;
    paths: string[];
  },
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
