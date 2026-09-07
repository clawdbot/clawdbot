// Clipboard copy helper shared by chat copy affordances.
//
// The async Clipboard API is only exposed in secure contexts (HTTPS or
// localhost). On plain-HTTP deployments (e.g. LAN access) `navigator.clipboard`
// is undefined, so calling it throws synchronously rather than rejecting. Guard
// the secure-context path and fall back to the legacy execCommand copy so the
// copy buttons keep working over HTTP. Returns whether the copy succeeded.
let clipboardWriteAttempt = 0;

export function beginClipboardCopy(): number {
  return ++clipboardWriteAttempt;
}

export async function copyToClipboard(
  text: string,
  shouldFallback?: () => boolean,
): Promise<boolean> {
  const attempt = beginClipboardCopy();
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
  // The clipboard is shared across controls. A newer copy or a retired caller
  // cancels this second transport before it can overwrite the user's selection.
  if (attempt !== clipboardWriteAttempt || (shouldFallback && !shouldFallback())) {
    return false;
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
      // Deferred focus must retain its document after that environment's globals retire.
      const ownerDocument = textarea.ownerDocument;
      window.setTimeout(() => {
        const { activeElement, body } = ownerDocument;
        if (previouslyFocused.isConnected && (!activeElement || activeElement === body)) {
          previouslyFocused.focus({ preventScroll: true });
        }
      }, 0);
    }
  }
}
