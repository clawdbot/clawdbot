type NativeWindowDragMessage = { type: "window-drag" };

type WebKitMessageHandler = {
  postMessage(message: NativeWindowDragMessage): void;
};

function getNativeWindowDragPoster(): WebKitMessageHandler["postMessage"] | undefined {
  // Native macOS hosts install this handler before navigation; its absence
  // (plain browsers, other hosts) keeps default mouse behavior.
  const handler = (
    window as unknown as {
      webkit?: { messageHandlers?: { openclawWindowDrag?: WebKitMessageHandler } };
    }
  ).webkit?.messageHandlers?.openclawWindowDrag;
  return handler?.postMessage.bind(handler);
}

const INTERACTIVE_TARGET_SELECTOR =
  "a, button, input, select, textarea, [role='button'], [contenteditable]";

/**
 * mousedown handler for chrome-like rows (split pane headers): asks the native
 * macOS host to move the window, matching titlebar drag behavior. Presses on
 * interactive children keep their normal click handling.
 */
export function beginNativeWindowDrag(event: MouseEvent): void {
  // Synthetic events cannot force a drag: the native handler only acts while
  // an actual left-mouse press is the app's current event.
  if (event.button !== 0 || event.defaultPrevented) {
    return;
  }
  for (const target of event.composedPath()) {
    if (target instanceof Element && target.matches(INTERACTIVE_TARGET_SELECTOR)) {
      return;
    }
  }
  const post = getNativeWindowDragPoster();
  if (!post) {
    return;
  }
  try {
    post({ type: "window-drag" });
  } catch {
    return;
  }
  // The native drag session owns the rest of the gesture; without this the
  // page still starts a text selection underneath the moving window.
  event.preventDefault();
}

/**
 * mousedown handler for scroll containers whose top padding doubles as
 * titlebar chrome (the chat thread's titlebar band): presses on the bare
 * container background inside that padding start a native window drag.
 * Content scrolled under the band hits its own elements, not the container,
 * so selection and clicks there keep default behavior.
 */
export function beginNativeWindowDragFromTopInset(event: MouseEvent): void {
  if (event.target !== event.currentTarget || !(event.currentTarget instanceof HTMLElement)) {
    return;
  }
  const inset = Number.parseFloat(getComputedStyle(event.currentTarget).paddingTop);
  if (!Number.isFinite(inset) || event.offsetY > inset) {
    return;
  }
  beginNativeWindowDrag(event);
}
