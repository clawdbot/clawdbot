// Clipboard copy helper shared by chat copy affordances.
//
// The async Clipboard API is only exposed in secure contexts (HTTPS or
// localhost). On plain-HTTP deployments (e.g. LAN access) `navigator.clipboard`
// is undefined, so calling it throws synchronously rather than rejecting. Guard
// the secure-context path and fall back to the legacy execCommand copy so the
// copy buttons keep working over HTTP.
const clipboardFeedbackTimers = new WeakMap<HTMLElement, number>();

export function replaceClipboardFeedback(
  element: HTMLElement,
  reset: () => void,
  show?: () => void,
  durationMs = 0,
): void {
  // One copy owns one timer; an earlier result must never erase a newer result.
  window.clearTimeout(clipboardFeedbackTimers.get(element));
  clipboardFeedbackTimers.delete(element);
  reset();
  if (!show) {
    return;
  }

  show();
  clipboardFeedbackTimers.set(
    element,
    window.setTimeout(() => {
      clipboardFeedbackTimers.delete(element);
      reset();
    }, durationMs),
  );
}

/** Returns whether the copy succeeded. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Secure-context API present but rejected (e.g. denied permission);
      // fall through to the execCommand path before giving up.
    }
  }
  return copyWithExecCommand(text);
}

function copyWithExecCommand(text: string): boolean {
  const textarea = document.createElement("textarea");
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  textarea.value = text;
  // Keep the scratch node off-screen so the selection does not scroll or flash.
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
    if (previouslyFocused?.isConnected) {
      window.setTimeout(() => {
        const activeElement = document.activeElement;
        if (previouslyFocused.isConnected && (!activeElement || activeElement === document.body)) {
          previouslyFocused.focus({ preventScroll: true });
        }
      }, 0);
    }
  }
}
