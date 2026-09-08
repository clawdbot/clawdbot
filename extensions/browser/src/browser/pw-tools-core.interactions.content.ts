import fs from "node:fs/promises";
import path from "node:path";
import { detectMime } from "openclaw/plugin-sdk/media-mime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import type { FileChooser, Locator, Page } from "playwright-core";
import { getImageMetadata } from "../media/media-services.js";
import { ACT_MAX_WAIT_TIME_MS, resolveActWaitTimeoutMs } from "./act-policy.js";
import { DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS } from "./constants.js";
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
  runCancellablePageInteraction,
  throwIfInteractionAborted,
} from "./pw-tools-core.interactions.navigation.js";
import { runPageEmulationTransition } from "./pw-tools-core.state.js";
import {
  ANNOTATION_MAX_LABELS_DEFAULT,
  type AnnotationItem,
  buildOverlayClearScript,
  buildOverlayInjectionScript,
  type CoordinateSpace,
  planAnnotations,
  type RawAnnotationInput,
  scaleAnnotations,
} from "./screenshot-annotate.js";

const DEFAULT_UPLOAD_MIME_TYPE = "application/octet-stream";
const PLAYWRIGHT_FILE_PAYLOAD_SIZE_LIMIT_BYTES = 50 * 1024 * 1024;

type PlaywrightFilePayload = {
  name: string;
  mimeType: string;
  buffer: Buffer;
  lastModifiedMs?: number;
};

async function toPlaywrightFilePayloads(paths: string[]): Promise<PlaywrightFilePayload[]> {
  const stats = await Promise.all(paths.map(async (filePath) => await fs.stat(filePath)));
  const totalSize = stats.reduce((size, stat) => size + stat.size, 0);
  if (totalSize >= PLAYWRIGHT_FILE_PAYLOAD_SIZE_LIMIT_BYTES) {
    throw new Error(
      "Cannot set buffer larger than 50Mb, please write it to a file and pass its path instead.",
    );
  }
  return await Promise.all(
    paths.map(async (filePath, index) => {
      const buffer = await fs.readFile(filePath);
      return {
        name: path.basename(filePath),
        mimeType: (await detectMime({ buffer, filePath })) ?? DEFAULT_UPLOAD_MIME_TYPE,
        buffer,
        lastModifiedMs: stats[index]?.mtimeMs,
      };
    }),
  );
}

function shouldUsePlaywrightFilePayloads(
  opts: Pick<NavigationTargetOptions, "browserFilesystemLocal" | "ssrfPolicy">,
): boolean {
  return Boolean(opts.ssrfPolicy) && opts.browserFilesystemLocal !== true;
}

async function resolvePlaywrightUploadFiles(opts: GuardedInteractionOptions & { paths: string[] }) {
  const { abortPromise, cleanup } = createAbortPromiseWithListener(opts.signal);
  try {
    return await awaitActionWithAbort(
      (async () => {
        const resolved = await resolveStrictExistingUploadPaths({ requestedPaths: opts.paths });
        if (!resolved.ok) {
          throw new Error(resolved.error);
        }
        return shouldUsePlaywrightFilePayloads(opts)
          ? await toPlaywrightFilePayloads(resolved.paths)
          : resolved.paths;
      })(),
      abortPromise,
    );
  } finally {
    cleanup();
  }
}

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

type ScreenshotOptions = {
  fullPage?: boolean;
  type?: "png" | "jpeg";
  timeoutMs?: number;
  signal?: AbortSignal;
};

async function runScreenshotOperation<T>(
  page: Page,
  opts: ScreenshotOptions,
  run: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, controller.signal])
    : controller.signal;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS;
  return await withTimeout(
    runPageEmulationTransition({ state: ensurePageState(page), signal, run: () => run(signal) }),
    timeoutMs,
    {
      createError: () => {
        const error = new Error(`Screenshot via Playwright timed out after ${timeoutMs}ms`);
        controller.abort(error);
        return error;
      },
    },
  );
}

function screenshotLocator(page: Page, ref?: string, element?: string): Locator | undefined {
  return ref ? refLocator(page, ref) : element ? page.locator(element).first() : undefined;
}

async function capturePageScreenshot(
  page: Page,
  opts: ScreenshotOptions,
  locator?: Locator,
): Promise<{ buffer: Buffer; clip?: { x: number; y: number; width: number } }> {
  opts.signal?.throwIfAborted();
  if (locator && opts.fullPage) {
    throw new Error("fullPage is not supported for element screenshots");
  }
  const type = opts.type ?? "png";
  const emulation = ensurePageState(page).emulation;
  const owner = emulation?.metricsOwner;
  const preparation = {
    timeout: opts.timeoutMs ?? DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS,
    signal: opts.signal,
  };
  // Resolve a fixed handle with a bounded wait: an unbounded Locator screenshot
  // could keep retrying a missing selector after the caller has already timed out.
  const element = await locator?.elementHandle({ timeout: preparation.timeout });
  try {
    await element?.scrollIntoViewIfNeeded(preparation);
    opts.signal?.throwIfAborted();
    if (!owner) {
      // The outer deadline owns cancellation. Playwright's timeout rejects
      // before native capture/restoration finishes, releasing the queue too early.
      return {
        buffer: await (element
          ? element.screenshot({ type, timeout: 0 })
          : page.screenshot({ type, fullPage: Boolean(opts.fullPage), timeout: 0 })),
      };
    }

    const box = element ? await element.boundingBox() : undefined;
    if (locator && (!box || !box.width || !box.height)) {
      throw new Error("Cannot take a screenshot of an element that is not visible or has no size");
    }
    const metrics = await owner.session.send("Page.getLayoutMetrics");
    const visual = metrics.cssVisualViewport;
    let clip = { ...metrics.cssContentSize, scale: 1 };
    if (box) {
      const x = Math.floor(box.x + visual.pageX);
      const y = Math.floor(box.y + visual.pageY);
      clip = {
        x,
        y,
        width: Math.ceil(box.x + visual.pageX + box.width) - x,
        height: Math.ceil(box.y + visual.pageY + box.height) - y,
        scale: 1,
      };
    } else if (!opts.fullPage) {
      clip = {
        x: visual.pageX,
        y: visual.pageY,
        width: Math.ceil(owner.viewport.width / visual.scale),
        height: Math.ceil(owner.viewport.height / visual.scale),
        scale: visual.scale,
      };
    }
    const captureBeyondViewport = Boolean(
      (opts.fullPage || locator) &&
      (clip.width > owner.viewport.width || clip.height > owner.viewport.height),
    );
    opts.signal?.throwIfAborted();
    // Chromium restores the capturing session's metrics. A new session or
    // Playwright's own session would replace this device owner's DPR and screen.
    const result = await owner.session.send("Page.captureScreenshot", {
      format: type,
      clip,
      captureBeyondViewport,
    });
    return { buffer: Buffer.from(result.data, "base64"), clip };
  } finally {
    try {
      if (emulation?.touch) {
        // Full-page and oversized element captures can reset touch emulation.
        // Both screenshot backends restore the value set by this page's owner.
        await emulation.touch.session.send("Emulation.setTouchEmulationEnabled", {
          enabled: emulation.touch.enabled,
        });
      }
    } finally {
      await element?.dispose();
    }
  }
}

export async function takeScreenshotViaPlaywright(
  opts: InteractionTargetOptions & ScreenshotOptions & { ref?: string; element?: string },
): Promise<{ buffer: Buffer }> {
  const page = await getPageForTargetId(opts);
  return await runScreenshotOperation(page, opts, async (signal) => {
    restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
    const { buffer } = await capturePageScreenshot(
      page,
      { ...opts, signal },
      screenshotLocator(page, opts.ref, opts.element),
    );
    return { buffer };
  });
}

type LabeledScreenshotOptions = InteractionTargetOptions &
  ScreenshotOptions & {
    refs: Record<string, { role: string; name?: string; nth?: number }>;
    maxLabels?: number;
    ref?: string;
    element?: string;
  };

export async function screenshotWithLabelsViaPlaywright(opts: LabeledScreenshotOptions) {
  const page = await getPageForTargetId(opts);
  return await runScreenshotOperation(page, opts, (signal) =>
    screenshotWithLabelsOnPage(page, { ...opts, signal }),
  );
}

async function screenshotWithLabelsOnPage(
  page: Page,
  opts: LabeledScreenshotOptions,
): Promise<{
  buffer: Buffer;
  labels: number;
  skipped: number;
  annotations: AnnotationItem[];
}> {
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  const maxLabels =
    typeof opts.maxLabels === "number" && Number.isFinite(opts.maxLabels)
      ? Math.max(1, Math.floor(opts.maxLabels))
      : ANNOTATION_MAX_LABELS_DEFAULT;

  const refKey = normalizeOptionalString(opts.ref) ?? undefined;
  const elementSelector = normalizeOptionalString(opts.element) ?? undefined;
  const locator = screenshotLocator(page, refKey, elementSelector);
  const space: CoordinateSpace = opts.fullPage
    ? "fullpage"
    : refKey || elementSelector
      ? "element"
      : "viewport";

  // DOM boxes use the visual viewport, including pan during mobile zoom.
  // Mixing the layout viewport here can produce negative element clips.
  const view = await page.evaluate(
    (viewportWidth) => ({
      x: window.visualViewport!.pageLeft,
      y: window.visualViewport!.pageTop,
      width: window.visualViewport!.width,
      height: window.visualViewport!.height,
      nativeCaptureWidth: Math.floor(
        (viewportWidth ?? window.innerWidth) / window.visualViewport!.scale + 1e-3,
      ),
      fullWidth: Math.max(
        document.body?.scrollWidth ?? 0,
        document.documentElement.scrollWidth,
        document.body?.offsetWidth ?? 0,
        document.documentElement.offsetWidth,
        document.body?.clientWidth ?? 0,
        document.documentElement.clientWidth,
      ),
    }),
    page.viewportSize()?.width,
  );

  let elementRect: { x: number; y: number; width: number; height: number } | undefined;
  if (space === "element") {
    const box = await locator?.boundingBox().catch(() => null);
    if (!box) {
      throw new Error(
        `screenshotWithLabelsViaPlaywright: element not found for ${
          refKey ? `ref="${refKey}"` : `selector="${elementSelector ?? ""}"`
        }`,
      );
    }
    // Convert viewport-space bbox to document space.
    elementRect = {
      x: box.x + view.x,
      y: box.y + view.y,
      width: box.width,
      height: box.height,
    };
  }

  const refKeys = Object.keys(opts.refs ?? {});
  const inputs: RawAnnotationInput[] = [];
  let skippedRefs = 0;
  for (const ref of refKeys) {
    const refInfo = opts.refs[ref];
    if (refInfo === undefined) {
      continue;
    }
    const target = refLocator(page, ref);
    // Full-page tail refs cannot contribute annotations after the label budget fills.
    if (space === "fullpage" && inputs.length >= maxLabels) {
      skippedRefs += 1;
      continue;
    }
    const box = await target.boundingBox().catch(() => null);
    if (!box) {
      skippedRefs += 1;
      continue;
    }
    inputs.push({
      ref,
      role: refInfo.role,
      name: refInfo.name,
      doc: {
        x: box.x + view.x,
        y: box.y + view.y,
        width: box.width,
        height: box.height,
      },
    });
  }

  const origin = space === "element" ? elementRect! : space === "viewport" ? view : { x: 0, y: 0 };
  const plan = planAnnotations({
    inputs,
    space,
    scroll: origin,
    viewport: view,
    elementRect,
    maxLabels,
  });

  try {
    opts.signal?.throwIfAborted();
    if (plan.overlayItems.length > 0) {
      await page.evaluate(
        buildOverlayInjectionScript({ items: plan.overlayItems, captureY: origin.y }),
      );
    }
    const capture = await capturePageScreenshot(page, opts, locator);
    // Native viewport captures include classic scrollbars and use page scale;
    // the visual viewport still owns element positioning and visibility.
    const clip =
      capture.clip ??
      (space === "viewport"
        ? { ...view, width: view.nativeCaptureWidth }
        : {
            x: Math.floor(origin.x + 1e-3),
            y: Math.floor(origin.y + 1e-3),
            width: elementRect
              ? Math.ceil(elementRect.x + elementRect.width - 1e-3) - Math.floor(origin.x + 1e-3)
              : view.fullWidth,
          });
    const image = await getImageMetadata(capture.buffer);
    if (!image) {
      throw new Error("Cannot determine screenshot dimensions for label annotations");
    }
    // Attached Playwright sessions can capture at a different density from
    // window.devicePixelRatio. The actual image and clip own this transform.
    const scale = image.width / clip.width;
    return {
      // `labels` reports overlay boxes actually drawn on the captured image
      // (in-viewport, within budget); off-viewport refs are surfaced via
      // `annotations` but not drawn, and are reflected in `skipped`.
      buffer: capture.buffer,
      labels: plan.overlayItems.length,
      skipped: plan.skipped + skippedRefs,
      annotations: scaleAnnotations(plan.annotations, scale, scale, {
        x: clip.x - origin.x,
        y: clip.y - origin.y,
      }),
    };
  } finally {
    await page.evaluate(buildOverlayClearScript()).catch(() => {});
  }
}

export async function setFileChooserFilesViaPlaywright(
  opts: GuardedInteractionOptions & {
    page: Page;
    fileChooser: FileChooser;
    paths: string[];
    timeoutMs: number;
  },
): Promise<void> {
  const resolvedFiles = await resolvePlaywrightUploadFiles(opts);
  await runCancellablePageInteraction(opts.page, opts, async (signal) => {
    await opts.fileChooser.setFiles(resolvedFiles, { timeout: opts.timeoutMs, signal });
  });
}

export async function setInputFilesViaPlaywright(
  opts: GuardedInteractionOptions & {
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
  const resolvedFiles = await resolvePlaywrightUploadFiles(opts);
  await runCancellablePageInteraction(
    page,
    opts,
    async (signal) => await locator.setInputFiles(resolvedFiles, { signal }),
    inputRef || element,
  );
}
