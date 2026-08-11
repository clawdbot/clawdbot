import type { CreateGhosttyTerminalOptions } from "@openclaw/libterminal/browser";

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
    dispose();
  };
  return controller;
}
