import type {
  CreateGhosttyTerminalOptions,
  GhosttyTerminalController,
} from "@openclaw/libterminal/browser";

/** Creates a terminal whose WASM memory is never reused by another tab. */
export async function createIsolatedGhosttyTerminal(
  options: CreateGhosttyTerminalOptions,
): Promise<GhosttyTerminalController> {
  const [{ createGhosttyTerminal, loadGhosttyRuntime }, ghosttyModule] = await Promise.all([
    import("@openclaw/libterminal/browser"),
    import("ghostty-web"),
  ]);
  // ghostty-web 0.4.0 reuses freed WASM pages, exposing stale cells and corrupting
  // later terminals (coder/ghostty-web#142). Per-tab runtimes confine disposal.
  const runtime = await loadGhosttyRuntime({ module: ghosttyModule });
  return createGhosttyTerminal({ ...options, runtime });
}
