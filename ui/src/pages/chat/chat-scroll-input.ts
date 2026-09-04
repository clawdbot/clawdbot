import { isApplePlatform } from "../../lib/keyboard-shortcut-contract.ts";

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export function isTranscriptScrollKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || !SCROLL_KEYS.has(event.key)) {
    return false;
  }
  const editingKey = event.key === " " || event.key === "ArrowUp" || event.key === "ArrowDown";
  const pagingKey = !editingKey && !event.shiftKey && !event.altKey && !event.metaKey;
  const applePlatform = isApplePlatform();
  // macOS forwards plain paging to scrolling; native caret/selection bindings
  // must not interrupt restoration. Single-line PageUp/Down also bubble elsewhere.
  const nativePaging = pagingKey && !event.ctrlKey && applePlatform;
  const upward =
    event.key === "ArrowUp" ||
    event.key === "PageUp" ||
    event.key === "Home" ||
    (event.key === " " && event.shiftKey);
  let editabilityResolved = false;
  // Inspect the composed path so native controls inside shadow roots keep
  // their navigation keys without cancelling transcript restoration or follow.
  for (const target of event.composedPath()) {
    if (target === event.currentTarget) {
      break;
    }
    if (!(target instanceof HTMLElement)) {
      continue;
    }
    // Native media handles playback, volume, and seeking without preventDefault;
    // only PageUp/Down on the host yield to transcript scrolling.
    if (target instanceof HTMLMediaElement && target.controls && !event.key.startsWith("Page")) {
      return false;
    }
    if (target instanceof HTMLInputElement) {
      if (target.type === "range") {
        if (event.key !== " ") {
          return false;
        }
      } else if (
        ["button", "checkbox", "color", "file", "image", "reset", "submit"].includes(target.type)
      ) {
        if (event.key === " ") {
          return false;
        }
      } else if (!nativePaging && !(pagingKey && !event.ctrlKey && event.key.startsWith("Page"))) {
        return false;
      }
    }
    if (
      target instanceof HTMLSelectElement &&
      (target.multiple ||
        target.size > 1 ||
        (!nativePaging &&
          !(pagingKey && event.ctrlKey && !applePlatform && !event.key.startsWith("Page"))))
    ) {
      return false;
    }
    if (target instanceof HTMLTextAreaElement && !nativePaging) {
      return false;
    }
    if (!editabilityResolved && target.hasAttribute("contenteditable")) {
      editabilityResolved = true;
      if (!target.matches('[contenteditable="false" i]') && !nativePaging) {
        return false;
      }
    }
    if (event.key === " " && target.matches("button, summary")) {
      return false;
    }
    // Native paging stays in a nested scrollport until its directional edge,
    // then chains to the transcript. Only the latter is transcript input.
    if (
      /^(auto|scroll)$/.test(getComputedStyle(target).overflowY) &&
      (upward ? target.scrollTop > 0 : target.scrollTop < target.scrollHeight - target.clientHeight)
    ) {
      return false;
    }
  }
  return true;
}
