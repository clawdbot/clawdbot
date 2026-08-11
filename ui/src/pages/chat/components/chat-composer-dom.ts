const COMPOSER_CHROME_INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "wa-dropdown",
  "[contenteditable='true']",
  "[role='button']",
  "[role='listbox']",
  "[role='option']",
].join(",");

type ComposerTextareaResizeObserverState = {
  observer: ResizeObserver;
  adjustmentFrame: number | null;
};

type ComposerPopoverAnchorObserverState = {
  resizeObserver: ResizeObserver | null;
  toggleObserver: MutationObserver | null;
  viewport: VisualViewport | null;
  updateFrame: number | null;
  scheduleUpdate: () => void;
};

const composerTextareaResizeObservers = new WeakMap<
  HTMLTextAreaElement,
  ComposerTextareaResizeObserverState
>();
const composerPopoverAnchorObservers = new WeakMap<
  HTMLElement,
  ComposerPopoverAnchorObserverState
>();

const COMPOSER_POPOVER_GAP_PX = 6;
// max-height constrains the menu's scrollable box before its border/padding;
// include that chrome so the outer panel retains a viewport gutter.
const COMPOSER_POPOVER_VIEWPORT_INSET_PX = 28;

function updateComposerPopoverAnchor(el: HTMLElement) {
  const viewport = window.visualViewport;
  const viewportTop = viewport?.offsetTop ?? 0;
  const layoutViewportHeight = document.documentElement.clientHeight || window.innerHeight;
  const composerTop = el.getBoundingClientRect().top;
  const bottom = layoutViewportHeight - composerTop + COMPOSER_POPOVER_GAP_PX;
  const maxHeight = composerTop - viewportTop - COMPOSER_POPOVER_VIEWPORT_INSET_PX;
  el.style.setProperty("--chat-composer-popover-bottom", `${Math.max(0, bottom)}px`);
  el.style.setProperty("--chat-composer-popover-max-height", `${Math.max(0, maxHeight)}px`);
}

function observeComposerPopoverAnchor(el: HTMLElement) {
  if (composerPopoverAnchorObservers.has(el)) {
    return;
  }
  const viewport = window.visualViewport;
  const state: ComposerPopoverAnchorObserverState = {
    resizeObserver: null,
    toggleObserver: null,
    viewport,
    updateFrame: null,
    scheduleUpdate: () => {
      if (state.updateFrame !== null) {
        return;
      }
      state.updateFrame = requestAnimationFrame(() => {
        state.updateFrame = null;
        if (composerPopoverAnchorObservers.get(el) === state) {
          updateComposerPopoverAnchor(el);
        }
      });
    },
  };
  if (typeof ResizeObserver === "function") {
    state.resizeObserver = new ResizeObserver(state.scheduleUpdate);
    state.resizeObserver.observe(el);
  }
  if (typeof MutationObserver === "function") {
    state.toggleObserver = new MutationObserver(state.scheduleUpdate);
    state.toggleObserver.observe(el, {
      attributes: true,
      attributeFilter: ["open"],
      subtree: true,
    });
  }
  window.addEventListener("resize", state.scheduleUpdate);
  viewport?.addEventListener("resize", state.scheduleUpdate);
  viewport?.addEventListener("scroll", state.scheduleUpdate);
  composerPopoverAnchorObservers.set(el, state);
  updateComposerPopoverAnchor(el);
}

export function disconnectComposerPopoverAnchorObserver(el: HTMLElement) {
  const state = composerPopoverAnchorObservers.get(el);
  composerPopoverAnchorObservers.delete(el);
  if (!state) {
    return;
  }
  state.resizeObserver?.disconnect();
  state.toggleObserver?.disconnect();
  window.removeEventListener("resize", state.scheduleUpdate);
  state.viewport?.removeEventListener("resize", state.scheduleUpdate);
  state.viewport?.removeEventListener("scroll", state.scheduleUpdate);
  if (state.updateFrame !== null) {
    cancelAnimationFrame(state.updateFrame);
  }
}

export function replaceComposerPopoverAnchor(
  previous: HTMLElement | null,
  element?: Element,
): HTMLElement | null {
  const next = element instanceof HTMLElement ? element : null;
  if (previous && previous !== next) {
    disconnectComposerPopoverAnchorObserver(previous);
  }
  if (next) {
    observeComposerPopoverAnchor(next);
  }
  return next;
}

function updateTextareaOverflow(el: HTMLTextAreaElement) {
  el.style.overflowY = el.scrollHeight > el.clientHeight ? "auto" : "hidden";
}

export function adjustTextareaHeight(el: HTMLTextAreaElement) {
  // Hide the browser's scrollbar while measuring; restore it only when the
  // final CSS-constrained height actually clips the draft.
  el.style.overflowY = "hidden";
  el.style.height = "auto";
  // The owning surface declares its cap in CSS. Retain the historical fallback
  // for detached/test controls whose computed max-height is not a pixel value.
  const computedMaxHeight = getComputedStyle(el).maxHeight.trim();
  const pixelMaxHeight = /^(\d+(?:\.\d+)?)px$/u.exec(computedMaxHeight);
  const maxHeight = pixelMaxHeight ? Number(pixelMaxHeight[1]) : 150;
  el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  updateTextareaOverflow(el);
}

export function observeTextareaOverflow(el: HTMLTextAreaElement) {
  if (typeof ResizeObserver !== "function" || composerTextareaResizeObservers.has(el)) {
    return;
  }
  let width = el.getBoundingClientRect().width;
  const observer = new ResizeObserver(() => {
    const nextWidth = el.getBoundingClientRect().width;
    if (nextWidth !== width) {
      width = nextWidth;
      const state = composerTextareaResizeObservers.get(el);
      if (state && state.adjustmentFrame === null) {
        state.adjustmentFrame = requestAnimationFrame(() => {
          state.adjustmentFrame = null;
          if (composerTextareaResizeObservers.get(el) === state) {
            adjustTextareaHeight(el);
          }
        });
      }
      return;
    }
    updateTextareaOverflow(el);
  });
  observer.observe(el);
  composerTextareaResizeObservers.set(el, { observer, adjustmentFrame: null });
}

export function disconnectTextareaOverflowObserver(el: HTMLTextAreaElement) {
  const state = composerTextareaResizeObservers.get(el);
  composerTextareaResizeObservers.delete(el);
  if (!state) {
    return;
  }
  state.observer.disconnect();
  if (state.adjustmentFrame !== null) {
    cancelAnimationFrame(state.adjustmentFrame);
  }
}

export function scheduleTextareaHeightAdjustment(el: HTMLTextAreaElement) {
  // Lit invokes ref callbacks before the textarea is connected and before its
  // controlled value is committed, so measure once the render has settled.
  queueMicrotask(() => {
    if (el.isConnected) {
      adjustTextareaHeight(el);
    }
  });
}

export function focusComposerFromChrome(event: MouseEvent, connected: boolean) {
  if (!connected || event.defaultPrevented) {
    return;
  }
  const target = event.target;
  const currentTarget = event.currentTarget;
  if (!(target instanceof Element) || !(currentTarget instanceof HTMLElement)) {
    return;
  }
  if (target.closest(COMPOSER_CHROME_INTERACTIVE_SELECTOR)) {
    return;
  }
  currentTarget
    .querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea")
    ?.focus({ preventScroll: true });
}

export function preserveComposerFocusOnPrimaryAction(
  event: PointerEvent,
  textarea: HTMLTextAreaElement | null,
): void {
  const composerShell = textarea?.closest<HTMLElement>(".agent-chat__composer-shell");
  if (
    document.activeElement === textarea &&
    composerShell &&
    Number.parseFloat(getComputedStyle(composerShell).marginBottom) === 0
  ) {
    event.preventDefault();
  }
}

export function restoreHistoryCaret(target: HTMLTextAreaElement, direction: "up" | "down") {
  requestAnimationFrame(() => {
    if (document.activeElement !== target) {
      return;
    }
    adjustTextareaHeight(target);
    const caret = direction === "up" ? 0 : target.value.length;
    target.selectionStart = caret;
    target.selectionEnd = caret;
  });
}
