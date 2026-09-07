import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";

type TerminalControllerSlot = {
  controller: GhosttyTerminalController;
  host: HTMLDivElement;
};

type TerminalControllerFactory = (
  parent: HTMLElement,
  options?: { readOnly?: boolean },
) => Promise<GhosttyTerminalController>;

const terminalOutputEncoder = new TextEncoder();

function activeElementFor(host: HTMLElement): Element | null {
  const root = host.getRootNode();
  return root instanceof ShadowRoot
    ? (root.activeElement ?? document.activeElement)
    : document.activeElement;
}

function hostOwnsFocus(host: HTMLElement, focused: Element | null): boolean {
  return focused === host || host.contains(focused);
}

function focusIfConnected(target: Element | null): void {
  if (target instanceof HTMLElement && target.isConnected) {
    target.focus();
  }
}

export function disposeTerminalController(
  controller: GhosttyTerminalController,
  host: HTMLDivElement,
): void {
  try {
    controller.dispose();
  } catch {
    // A partially initialized controller may fail during best-effort teardown.
  } finally {
    host.remove();
  }
}

/** Replays recovery output into a hidden replacement, then atomically swaps it in. */
export async function replaceTerminalController(
  target: TerminalControllerSlot,
  createController: TerminalControllerFactory,
  replay: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) {
    return false;
  }

  const previousController = target.controller;
  const previousHost = target.host;
  const previouslyFocused = activeElementFor(previousHost);
  const previousTerminalOwnedFocus = hostOwnsFocus(previousHost, previouslyFocused);
  const replacementHost = previousHost.cloneNode() as HTMLDivElement;
  // The host is absolutely inset in the viewport. Keep it measurable while
  // hidden so Ghostty fits the authoritative replay to the real terminal grid.
  replacementHost.style.display = "block";
  replacementHost.style.visibility = "hidden";
  replacementHost.inert = true;
  previousHost.before(replacementHost);

  let replacement: GhosttyTerminalController | undefined;
  const disposeUnpublishedReplacement = () => {
    if (hostOwnsFocus(replacementHost, activeElementFor(replacementHost))) {
      focusIfConnected(previouslyFocused);
    }
    if (replacement) {
      disposeTerminalController(replacement, replacementHost);
    } else {
      replacementHost.remove();
    }
  };
  try {
    // Ghostty autofocuses during open. Stage read-only so hidden focus can
    // never forward keyboard input before the replacement is published.
    replacement = await createController(replacementHost, { readOnly: true });
    if (signal.aborted) {
      disposeUnpublishedReplacement();
      return false;
    }
    if (replay) {
      replacement.write(terminalOutputEncoder.encode(replay));
    }
    // ghostty-web 0.4.0 focuses during open and again in a zero-delay task.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    if (signal.aborted) {
      disposeUnpublishedReplacement();
      return false;
    }
  } catch (error) {
    disposeUnpublishedReplacement();
    throw error;
  }

  const currentlyFocused = activeElementFor(previousHost);
  let focusTarget: Element | null = null;
  if (hostOwnsFocus(previousHost, currentlyFocused)) {
    focusTarget = replacementHost;
  } else if (hostOwnsFocus(replacementHost, currentlyFocused)) {
    focusTarget = previousTerminalOwnedFocus ? replacementHost : previouslyFocused;
  }
  replacementHost.inert = false;
  replacement.setReadOnly(previousController.readOnly);
  replacementHost.style.display = previousHost.style.display;
  replacementHost.style.visibility = previousHost.style.visibility;
  target.controller = replacement;
  target.host = replacementHost;
  disposeTerminalController(previousController, previousHost);
  focusIfConnected(focusTarget);
  return true;
}
