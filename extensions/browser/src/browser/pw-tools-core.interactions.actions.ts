import { resolveNonNegativeIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Page } from "playwright-core";
import { ACT_MAX_CLICK_DELAY_MS, resolveActInteractionTimeoutMs } from "./act-policy.js";
import type { BrowserFormField } from "./client-actions.types.js";
import { normalizeBrowserEvaluateFunctionSource } from "./evaluate-source.js";
import { DEFAULT_FILL_FIELD_TYPE } from "./form-fields.js";
import {
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  isBrowserObservedDialogBlockedError,
  refLocator,
  restoreRoleRefsForTarget,
} from "./pw-session.js";
import {
  awaitNavigationGuardedInteraction,
  createAbortPromiseWithListener,
  type ElementInteractionOptions,
  getRestoredPageForTarget,
  type GuardedInteractionOptions,
  type InteractionTargetOptions,
  interactionNavigationPolicy,
  reconcileRemoteDialogAfterActionSettled,
  resolveBoundedDelayMs,
  throwIfInteractionAborted,
  toFriendlyInteractionError,
} from "./pw-tools-core.interactions.navigation.js";
import { normalizeTimeoutMs, requireRef, requireRefOrSelector } from "./pw-tools-core.shared.js";

export async function highlightViaPlaywright(
  opts: InteractionTargetOptions & {
    ref: string;
  },
): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const ref = requireRef(opts.ref);
  try {
    await refLocator(page, ref).highlight();
  } catch (err) {
    throw toFriendlyInteractionError(err, ref);
  }
}

export async function clickViaPlaywright(
  opts: ElementInteractionOptions & {
    doubleClick?: boolean;
    button?: "left" | "right" | "middle";
    modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
    delayMs?: number;
    resolvedPage?: Page;
  },
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
  const timeout = resolveActInteractionTimeoutMs(opts.timeoutMs);
  const signal = opts.signal;
  const { abortPromise, cleanup } = createAbortPromiseWithListener(signal, (reason) => {
    if (isBrowserObservedDialogBlockedError(reason)) {
      return;
    }
    void forceDisconnectPlaywrightForTarget({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      ssrfPolicy: opts.ssrfPolicy,
      reason: "click aborted",
    }).catch(() => {});
  });
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
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
            // Abortable hold: a bare setTimeout would keep the orphaned action
            // chain (and its navigation-guard teardown) alive for the full
            // delayMs after the caller already lost the abort race.
            await sleepWithAbort(delayMs, signal);
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
    cleanup();
  }
}

export async function clickCoordsViaPlaywright(
  opts: GuardedInteractionOptions & {
    x: number;
    y: number;
    doubleClick?: boolean;
    button?: "left" | "right" | "middle";
    delayMs?: number;
  },
): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const { abortPromise, cleanup } = createAbortPromiseWithListener(opts.signal);
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

export async function hoverViaPlaywright(opts: ElementInteractionOptions): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector!;
  const locator = resolved.ref
    ? refLocator(page, requireRef(resolved.ref))
    : page.locator(resolved.selector!);
  const { abortPromise, cleanup } = createAbortPromiseWithListener(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await awaitNavigationGuardedInteraction(
      {
        action: async () =>
          await locator.hover({
            timeout: resolveActInteractionTimeoutMs(opts.timeoutMs),
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

export async function dragViaPlaywright(
  opts: GuardedInteractionOptions & {
    startRef?: string;
    startSelector?: string;
    endRef?: string;
    endSelector?: string;
    timeoutMs?: number;
  },
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
  const { abortPromise, cleanup } = createAbortPromiseWithListener(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await awaitNavigationGuardedInteraction(
      {
        action: async () =>
          await startLocator.dragTo(endLocator, {
            timeout: resolveActInteractionTimeoutMs(opts.timeoutMs),
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

export async function selectOptionViaPlaywright(
  opts: ElementInteractionOptions & {
    values: string[];
  },
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
  const { abortPromise, cleanup } = createAbortPromiseWithListener(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await awaitNavigationGuardedInteraction(
      {
        action: async () => {
          await locator.selectOption(opts.values, {
            timeout: resolveActInteractionTimeoutMs(opts.timeoutMs),
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

export async function pressKeyViaPlaywright(
  opts: GuardedInteractionOptions & {
    key: string;
    delayMs?: number;
  },
): Promise<void> {
  const key = normalizeOptionalString(opts.key) ?? "";
  if (!key) {
    throw new Error("key is required");
  }
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const { abortPromise, cleanup } = createAbortPromiseWithListener(opts.signal);
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

export async function typeViaPlaywright(
  opts: ElementInteractionOptions & {
    text: string;
    submit?: boolean;
    slowly?: boolean;
  },
): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const text = opts.text ?? "";
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector!;
  const locator = resolved.ref
    ? refLocator(page, requireRef(resolved.ref))
    : page.locator(resolved.selector!);
  const timeout = resolveActInteractionTimeoutMs(opts.timeoutMs);
  const { abortPromise, cleanup } = createAbortPromiseWithListener(opts.signal);
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

export async function fillFormViaPlaywright(
  opts: GuardedInteractionOptions & {
    fields: BrowserFormField[];
    timeoutMs?: number;
  },
): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const timeout = resolveActInteractionTimeoutMs(opts.timeoutMs);
  const { abortPromise, cleanup } = createAbortPromiseWithListener(opts.signal);
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

export async function evaluateViaPlaywright(
  opts: GuardedInteractionOptions & {
    fn: string;
    ref?: string;
    timeoutMs?: number;
  },
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

export async function scrollIntoViewViaPlaywright(opts: ElementInteractionOptions): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = await getRestoredPageForTarget(opts);
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 20_000);

  const label = resolved.ref ?? resolved.selector!;
  const locator = resolved.ref
    ? refLocator(page, requireRef(resolved.ref))
    : page.locator(resolved.selector!);
  const { abortPromise, cleanup } = createAbortPromiseWithListener(opts.signal);
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
