import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";
import type { TerminalControllerFactory } from "./terminal-panel-session-types.ts";

type TerminalControllerSlot = {
  controller: GhosttyTerminalController;
  host: HTMLDivElement;
};

function getActiveElementForHost(host: HTMLElement): Element | null {
  const root = host.getRootNode();
  return root instanceof ShadowRoot
    ? (root.activeElement ?? document.activeElement)
    : document.activeElement;
}

export function disposeTerminalController(
  controller: GhosttyTerminalController,
  host: HTMLDivElement,
): void {
  try {
    const terminal = controller.terminal as unknown as { handleMouseUp?: unknown };
    if (typeof document !== "undefined" && typeof terminal.handleMouseUp === "function") {
      // ghostty-web 0.4.0 clears isOpen before cleanup, skipping this listener removal.
      document.removeEventListener("mouseup", terminal.handleMouseUp as EventListener);
    }
  } catch {
    // A partially initialized dependency terminal may not expose its internals.
  }
  try {
    controller.dispose();
  } catch {
    // Best-effort teardown; a partially initialized controller may throw.
  } finally {
    // DOM ownership is independent of controller cleanup; never strand a
    // Ghostty canvas when dependency disposal fails partway through.
    host.remove();
  }
}

/** Replays recovery output into a hidden replacement, then atomically swaps it in. */
export async function replaceTerminalControllerForReplay(params: {
  target: TerminalControllerSlot;
  createController: TerminalControllerFactory;
  replay: Uint8Array;
  isCurrent: () => boolean;
}): Promise<boolean> {
  if (!params.isCurrent()) {
    return false;
  }

  const previousController = params.target.controller;
  const previousHost = params.target.host;
  const previouslyFocused = getActiveElementForHost(previousHost);
  const previousTerminalOwnedFocus =
    previouslyFocused === previousHost || previousHost.contains(previouslyFocused);
  const replacementHost = previousHost.cloneNode() as HTMLDivElement;
  // The host is absolutely inset in the viewport. Keep it measurable while
  // hidden so Ghostty fits the authoritative replay to the real terminal grid.
  replacementHost.style.display = "block";
  replacementHost.style.visibility = "hidden";
  replacementHost.inert = true;
  previousHost.before(replacementHost);

  let replacement: GhosttyTerminalController | undefined;
  const disposeUnpublishedReplacement = () => {
    const focused = getActiveElementForHost(replacementHost);
    if (
      (focused === replacementHost || replacementHost.contains(focused)) &&
      previouslyFocused instanceof HTMLElement &&
      previouslyFocused.isConnected
    ) {
      previouslyFocused.focus();
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
    replacement = await params.createController(replacementHost, { readOnly: true });
    if (!params.isCurrent()) {
      disposeUnpublishedReplacement();
      return false;
    }
    if (params.replay.length > 0) {
      replacement.write(params.replay);
    }
    // ghostty-web 0.4.0 focuses during open and again in a zero-delay task.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    if (!params.isCurrent()) {
      disposeUnpublishedReplacement();
      return false;
    }
  } catch (error) {
    disposeUnpublishedReplacement();
    throw error;
  }

  const currentlyFocused = getActiveElementForHost(previousHost);
  const previousTerminalOwnsCurrentFocus =
    currentlyFocused === previousHost || previousHost.contains(currentlyFocused);
  const replacementOwnsCurrentFocus =
    currentlyFocused === replacementHost || replacementHost.contains(currentlyFocused);
  const shouldFocusReplacement =
    previousTerminalOwnsCurrentFocus || (previousTerminalOwnedFocus && replacementOwnsCurrentFocus);
  const shouldRestorePreviousFocus = !previousTerminalOwnedFocus && replacementOwnsCurrentFocus;
  replacementHost.inert = false;
  replacement.setReadOnly(previousController.readOnly);
  replacementHost.style.display = previousHost.style.display;
  replacementHost.style.visibility = previousHost.style.visibility;
  params.target.controller = replacement;
  params.target.host = replacementHost;
  disposeTerminalController(previousController, previousHost);
  if (shouldFocusReplacement) {
    replacementHost.focus();
  } else if (
    shouldRestorePreviousFocus &&
    previouslyFocused instanceof HTMLElement &&
    previouslyFocused.isConnected
  ) {
    previouslyFocused.focus();
  }
  return true;
}
