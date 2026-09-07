export function hasNativeBrowserBridge(): boolean {
  const host:
    | (Window & {
        webkit?: { messageHandlers?: { openclawBrowser?: { postMessage?: unknown } } };
      })
    | undefined = typeof window === "undefined" ? undefined : window;
  return typeof host?.webkit?.messageHandlers?.openclawBrowser?.postMessage === "function";
}
