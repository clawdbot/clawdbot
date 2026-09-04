const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export function isTranscriptScrollKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || !SCROLL_KEYS.has(event.key)) {
    return false;
  }
  const editingKey = event.key === " " || event.key === "ArrowUp" || event.key === "ArrowDown";
  // Inspect the composed path so native controls inside shadow roots keep
  // their navigation keys without cancelling transcript restoration or follow.
  for (const target of event.composedPath()) {
    if (!(target instanceof HTMLElement)) {
      continue;
    }
    if (target instanceof HTMLInputElement) {
      if (target.type === "range") {
        return event.key === " ";
      }
      if (
        ["button", "checkbox", "color", "file", "image", "reset", "submit"].includes(target.type)
      ) {
        return event.key !== " ";
      }
      return !editingKey;
    }
    if (target instanceof HTMLSelectElement) {
      return !target.multiple && target.size <= 1 && !editingKey;
    }
    if (target instanceof HTMLTextAreaElement) {
      return !editingKey;
    }
    if (target.hasAttribute("contenteditable")) {
      return target.matches('[contenteditable="false" i]') || !editingKey;
    }
    if (event.key === " " && target.matches("button, summary")) {
      return false;
    }
  }
  return true;
}
