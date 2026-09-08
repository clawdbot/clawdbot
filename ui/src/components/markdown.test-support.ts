export function htmlFragment(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

export function withControlUiBasePath<T>(basePath: string, fn: () => T): T {
  const testWindow = window as Window & typeof globalThis & { [key: string]: unknown };
  Object.defineProperty(window, "__OPENCLAW_CONTROL_UI_BASE_PATH__", {
    value: basePath,
    writable: true,
    configurable: true,
  });
  try {
    return fn();
  } finally {
    delete testWindow["__OPENCLAW_CONTROL_UI_BASE_PATH__"];
  }
}
