// Browser-safe Control UI base-path normalization shared by route contracts and Gateway callers.

/** Normalizes a Control UI base path to either "" or a leading-slash path without trailing slash. */
export function normalizeControlUiBasePath(basePath?: string | null): string {
  if (!basePath) {
    return "";
  }
  let normalized = basePath.trim();
  if (!normalized) {
    return "";
  }
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized === "/") {
    return "";
  }
  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}
