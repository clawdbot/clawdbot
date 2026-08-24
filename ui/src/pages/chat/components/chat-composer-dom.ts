import { captureChatSessionScrollPosition } from "../scroll.ts";

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
  observer: ResizeObserver | null;
  adjustmentFrame: number | null;
  onScroll: () => void;
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
  const scrollable = el.scrollHeight > el.clientHeight + 1;
  // Two 16px fades need enough vertical runway not to overlap into a narrow
  // opaque strip on short drafts. Small overflows still scroll, just unfaded.
  const canFade = scrollable && el.clientHeight >= 64;
  const fadeTop = canFade && el.scrollTop > 1;
  const fadeBottom = canFade && el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  el.style.overflowY = scrollable ? "auto" : "hidden";
  el.toggleAttribute("data-scroll-fade-top", fadeTop);
  el.toggleAttribute("data-scroll-fade-bottom", fadeBottom);
}

export function adjustTextareaHeight(el: HTMLTextAreaElement) {
  // A surface that declares the compact shape is a fixed CSS box: it holds one
  // line whatever the draft is, so an inline height left by an earlier measured
  // pass would silently outrank the stylesheet. Which shape a composer is in is
  // declared in its markup, never inferred here from how much text it holds.
  if (el.closest('[data-composer-layout="single-line"]')) {
    el.style.height = "";
    el.style.overflowY = "";
    el.removeAttribute("data-scroll-fade-top");
    el.removeAttribute("data-scroll-fade-bottom");
    return;
  }
  const thread = el.closest(".chat")?.querySelector<HTMLElement>(".chat-thread") ?? null;
  const preserveBottomAnchor = thread
    ? captureChatSessionScrollPosition(thread).anchorToEnd
    : false;
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
  // Once capped, the textarea can perturb the sibling transcript without
  // resizing its viewport, so ResizeObserver has no correction to apply.
  if (thread && preserveBottomAnchor) {
    thread.scrollTop = thread.scrollHeight;
  }
}

export function observeTextareaOverflow(el: HTMLTextAreaElement) {
  if (composerTextareaResizeObservers.has(el)) {
    return;
  }
  let width = el.getBoundingClientRect().width;
  const onScroll = () => updateTextareaOverflow(el);
  const observer =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
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
        })
      : null;
  el.addEventListener("scroll", onScroll, { passive: true });
  observer?.observe(el);
  composerTextareaResizeObservers.set(el, { observer, adjustmentFrame: null, onScroll });
  updateTextareaOverflow(el);
}

export function disconnectTextareaOverflowObserver(el: HTMLTextAreaElement) {
  const state = composerTextareaResizeObservers.get(el);
  composerTextareaResizeObservers.delete(el);
  if (!state) {
    return;
  }
  state.observer?.disconnect();
  el.removeEventListener("scroll", state.onScroll);
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

export function focusComposerFromChrome(event: MouseEvent | PointerEvent, connected: boolean) {
  if (event.defaultPrevented) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  if (event.type === "pointerdown") {
    // Cancel only pointer focus; click and popover-owned focus still run.
    if (event.button === 0 && target.closest("summary, wa-dropdown>[slot='trigger']")) {
      event.preventDefault();
    }
    return;
  }
  if (!connected) {
    return;
  }
  if (target.closest(COMPOSER_CHROME_INTERACTIVE_SELECTOR)) {
    return;
  }
  const currentTarget = event.currentTarget;
  if (!(currentTarget instanceof HTMLElement)) {
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

// Shared by the slash and skill composer menus, which resolve their own
// active-option id but scroll the same ".slash-menu__scroll" viewport shape.
export function scrollActiveMenuOptionIntoView(activeId: string | null): void {
  if (!activeId) {
    return;
  }
  requestAnimationFrame(() => {
    const activeOption = document.getElementById(activeId);
    const scrollRegion = activeOption?.closest<HTMLElement>(".slash-menu__scroll");
    if (!activeOption || !scrollRegion) {
      return;
    }
    const menuBounds = scrollRegion.getBoundingClientRect();
    const optionBounds = activeOption.getBoundingClientRect();
    // scrollIntoView also moves the short-landscape composer and page. Keep
    // keyboard navigation owned by the menu so textarea focus stays stable.
    if (optionBounds.top < menuBounds.top) {
      scrollRegion.scrollTop -= menuBounds.top - optionBounds.top;
    } else if (optionBounds.bottom > menuBounds.bottom) {
      scrollRegion.scrollTop += optionBounds.bottom - menuBounds.bottom;
    }
  });
}

export function syncComposerMenuScroll(element: Element | undefined): void {
  if (!(element instanceof HTMLElement)) {
    return;
  }
  const sync = () => {
    const scrollable = element.scrollHeight > element.clientHeight + 1;
    element.dataset.scrollable = String(scrollable);
    element.dataset.atStart = String(!scrollable || element.scrollTop <= 1);
    element.dataset.atEnd = String(
      !scrollable || element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
    );
  };
  sync();
  requestAnimationFrame(sync);
}

export function paneDomId(paneId: string, suffix: string): string {
  return `chat-${encodeURIComponent(paneId)}-${suffix}`;
}
