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

const composerTextareaResizeObservers = new WeakMap<
  HTMLTextAreaElement,
  ComposerTextareaResizeObserverState
>();
const questionDockResizeObservers = new WeakMap<HTMLElement, ResizeObserver>();

function updateTextareaOverflow(el: HTMLTextAreaElement) {
  el.style.overflowY = el.scrollHeight > el.clientHeight ? "auto" : "hidden";
}

export function adjustTextareaHeight(el: HTMLTextAreaElement) {
  // Hide the browser's scrollbar while measuring; restore it only when the
  // final CSS-constrained height actually clips the draft.
  el.style.overflowY = "hidden";
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
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

function syncQuestionDockHeight(el: HTMLElement): void {
  el.closest<HTMLElement>(".chat")?.style.setProperty(
    "--chat-question-dock-height",
    `${el.offsetHeight}px`,
  );
}

export function observeQuestionDock(el: HTMLElement): void {
  syncQuestionDockHeight(el);
  if (typeof ResizeObserver !== "function" || questionDockResizeObservers.has(el)) {
    return;
  }
  const observer = new ResizeObserver(() => syncQuestionDockHeight(el));
  observer.observe(el);
  questionDockResizeObservers.set(el, observer);
}

export function disconnectQuestionDock(el: HTMLElement): void {
  questionDockResizeObservers.get(el)?.disconnect();
  questionDockResizeObservers.delete(el);
  el.closest<HTMLElement>(".chat")?.style.removeProperty("--chat-question-dock-height");
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
