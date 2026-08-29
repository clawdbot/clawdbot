import "./tooltip.ts";
import { collectTooltipNameText, isTooltipTriggerElement } from "./tooltip-content.ts";

function titleNamesElement(element: Element) {
  if (
    element.hasAttribute("aria-label") ||
    element.hasAttribute("aria-labelledby") ||
    element.matches("img[alt], input[alt]") ||
    collectTooltipNameText(element).trim()
  ) {
    return false;
  }
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return (
      !element.labels?.length &&
      !element.matches('input[type="button"], input[type="submit"], input[type="reset"]')
    );
  }
  return true;
}

/** `title` remains a declarative hint source; only the shared Tooltip renders it. */
export function installTitleTooltips(ownerDocument: Document) {
  let tooltip: HTMLElementTagNameMap["openclaw-tooltip"] | null = null;
  let active: {
    anchor: HTMLElement | SVGElement;
    title: string | null;
    label: string | null;
    pointer: boolean;
    focus: boolean;
  } | null = null;

  const restore = () => {
    if (!active) {
      return;
    }
    const { anchor, title, label } = active;
    active = null;
    observer.disconnect();
    anchor.removeEventListener("pointerleave", handlePointerLeave);
    anchor.removeEventListener("focusout", handleFocusOut);
    if (title !== null && anchor.getAttribute("title") === "") {
      anchor.setAttribute("title", title);
    }
    if (label !== null && anchor.getAttribute("aria-label") === label) {
      anchor.removeAttribute("aria-label");
    }
    if (tooltip) {
      tooltip.anchor = null;
      tooltip.remove();
    }
  };

  const content = () => active?.anchor.getAttribute("data-tooltip") ?? active?.title ?? "";
  const update = (records: MutationRecord[]) => {
    if (!active) {
      return;
    }
    if (!active.anchor.isConnected) {
      restore();
      return;
    }
    if (!records.some((record) => active?.anchor.contains(record.target))) {
      return;
    }
    if (
      records.some((record) => record.target === active?.anchor && record.attributeName === "title")
    ) {
      active.title = active.anchor.getAttribute("title");
      if (active.title !== null) {
        active.anchor.setAttribute("title", "");
        // Drop only our synchronous suppression write; a real empty title must
        // still clear a disabled reason or a completed action's previous hint.
        observer.takeRecords();
      }
    }
    if (active.label !== null && active.anchor.getAttribute("aria-label") === active.label) {
      active.anchor.removeAttribute("aria-label");
      active.label = null;
    }
    if (active.title && titleNamesElement(active.anchor)) {
      active.label = active.title;
      active.anchor.setAttribute("aria-label", active.label);
    }
    if (tooltip) {
      // Updates refresh an open hint, never reopen a dismissed action. Reentry
      // or keyboard focus supplies new intent after an empty title clears it.
      tooltip.content = content();
    }
  };
  const observer = new MutationObserver(update);
  const handlePointerLeave = (event: Event) => {
    if (!active || event.target !== active.anchor) {
      return;
    }
    active.pointer = false;
    if (!active.focus) {
      restore();
    }
  };
  const handleFocusOut = (event: Event) => {
    if (
      !active ||
      (event instanceof FocusEvent &&
        event.relatedTarget instanceof Node &&
        active.anchor.contains(event.relatedTarget))
    ) {
      return;
    }
    active.focus = false;
    if (!active.pointer) {
      restore();
    }
  };
  const discover = (event: Event) => {
    if ("pointerType" in event && event.pointerType === "touch") {
      return;
    }
    const elements = event.composedPath().filter(isTooltipTriggerElement);
    // Iframe titles name browsing contexts, not hints. Explicit wrappers already
    // own their trigger; adapting those again would create competing popups.
    const explicit = elements.some((element) => element.localName === "openclaw-tooltip");
    let anchor: HTMLElement | SVGElement | undefined;
    for (const element of elements) {
      if (element.localName === "iframe") {
        break;
      }
      const title = element === active?.anchor ? active.title : element.getAttribute("title");
      const hint = element.getAttribute("data-tooltip") ?? title;
      if (hint !== null) {
        anchor = hint ? element : undefined;
        break;
      }
    }
    const input = event.type === "focusin" ? "focus" : "pointer";
    if (anchor === active?.anchor) {
      if (active) {
        active[input] = true;
      }
      return;
    }
    if (!anchor && active?.focus && input === "pointer") {
      return;
    }
    restore();
    if (!anchor) {
      return;
    }
    const title = anchor.getAttribute("title");
    const label = title && titleNamesElement(anchor) ? title : null;
    active = { anchor, title, label, pointer: input === "pointer", focus: input === "focus" };
    if (title !== null) {
      // An empty title blocks browser inheritance without exposing the next ancestor.
      anchor.setAttribute("title", "");
    }
    if (label !== null) {
      anchor.setAttribute("aria-label", label);
    }
    anchor.addEventListener("pointerleave", handlePointerLeave);
    anchor.addEventListener("focusout", handleFocusOut);
    observer.observe(anchor, {
      attributes: true,
      attributeFilter: ["title", "data-tooltip", "aria-hidden"],
      characterData: true,
      subtree: true,
    });
    observer.observe(ownerDocument, { childList: true, subtree: true });
    const root = anchor.getRootNode();
    if (root instanceof ShadowRoot) {
      observer.observe(root, { childList: true, subtree: true });
    }
    if (!explicit) {
      tooltip ??= ownerDocument.createElement("openclaw-tooltip");
      const mount =
        elements.find((element) => element.localName === "openclaw-modal-dialog") ??
        ownerDocument.body;
      mount.append(tooltip);
      tooltip.previewForAnchor(anchor, content(), input);
    }
  };
  ownerDocument.addEventListener("pointerover", discover, true);
  ownerDocument.addEventListener("focusin", discover, true);
  return () => {
    ownerDocument.removeEventListener("pointerover", discover, true);
    ownerDocument.removeEventListener("focusin", discover, true);
    restore();
  };
}
