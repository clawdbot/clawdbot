import type { CreateGhosttyTerminalOptions } from "@openclaw/libterminal/browser";

/**
 * Whether the browser is running on Windows. Right-click-to-paste is a
 * Windows terminal convention (cmd.exe / PowerShell / Windows Terminal), so we
 * only enable the behavior there and leave other platforms' default
 * right-click semantics (word selection / context menu) untouched.
 */
const IS_WINDOWS =
  typeof navigator !== "undefined" &&
  /Windows/i.test(navigator.userAgent);

/** Creates a terminal whose WASM memory is never reused by another tab. */
export async function createIsolatedGhosttyTerminal(options: CreateGhosttyTerminalOptions) {
  const [{ createGhosttyTerminal, loadGhosttyRuntime }, ghosttyModule] = await Promise.all([
    import("@openclaw/libterminal/browser"),
    import("ghostty-web"),
  ]);
  // ghostty-web 0.4.0 reuses freed WASM pages, exposing stale cells and corrupting
  // later terminals (coder/ghostty-web#142). Per-tab runtimes confine disposal.
  const runtime = await loadGhosttyRuntime({ module: ghosttyModule });
  const controller = await createGhosttyTerminal({ ...options, runtime });
  const dispose = controller.dispose.bind(controller);
  const terminal = controller.terminal as unknown as { handleMouseUp?: unknown };
  let handleMouseUp =
    typeof terminal.handleMouseUp === "function"
      ? (terminal.handleMouseUp as EventListener)
      : undefined;
  let disposed = false;

  /**
   * Windows right-click paste: reads the clipboard and inserts it into the
   * terminal, matching the muscle memory of cmd.exe / PowerShell / Windows
   * Terminal users. The listener is scoped to the terminal's own host element
   * (capture phase) so other surfaces' context menus are untouched, and on
   * non-Windows platforms the browser default (word selection / context menu)
   * is preserved.
   */
  let handleContextMenu: ((event: MouseEvent) => void) | undefined;
  if (IS_WINDOWS && typeof navigator.clipboard?.readText === "function") {
    const host = options.parent;
    handleContextMenu = (event: MouseEvent) => {
      if (!host.contains(event.target as Node)) {
        return;
      }
      event.preventDefault();
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text) {
            // Ghostty preserves bracketed-paste mode: pasted text is inserted
            // as editable input and never auto-executes a command.
            terminal.paste(text);
            terminal.focus();
          }
        })
        .catch(() => {
          // Clipboard read can be denied by permissions; fall back to the
          // default behavior instead of silently swallowing the click.
          document.removeEventListener("contextmenu", handleContextMenu, true);
          handleContextMenu = undefined;
        });
    };
    document.addEventListener("contextmenu", handleContextMenu, true);
  }

  controller.dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    // ghostty-web 0.4.0 clears isOpen before cleanup, skipping this listener removal.
    if (handleMouseUp) {
      document.removeEventListener("mouseup", handleMouseUp);
      handleMouseUp = undefined;
    }
    if (handleContextMenu) {
      document.removeEventListener("contextmenu", handleContextMenu, true);
      handleContextMenu = undefined;
    }
    dispose();
  };
  return controller;
}
