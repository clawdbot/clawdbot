export function hasNativeBrowserBridge(): boolean {
  const host =
    typeof window === "undefined"
      ? undefined
      : (window as Window & {
          webkit?: { messageHandlers?: { openclawBrowser?: { postMessage?: unknown } } };
        });
  return typeof host?.webkit?.messageHandlers?.openclawBrowser?.postMessage === "function";
}
