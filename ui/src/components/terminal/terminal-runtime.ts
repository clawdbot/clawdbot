import type { CreateGhosttyTerminalOptions } from "@openclaw/libterminal/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

function isEventListener(value: unknown): value is EventListener {
  return typeof value === "function";
}

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
  const terminal = controller.terminal;
  // Ghostty ignores defaultPrevented; its custom handler returns true to consume.
  // App capture listeners own dock shortcuts before they can become PTY input.
  terminal.attachCustomKeyEventHandler((event) => event.defaultPrevented);
  const mouseUpCandidate = asOptionalRecord(terminal)?.handleMouseUp;
  let handleMouseUp = isEventListener(mouseUpCandidate) ? mouseUpCandidate : undefined;
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
