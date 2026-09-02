/** Extract a string URL from the common request-like inputs accepted by fetch helpers. */
export function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  // Avoid `instanceof Request` so tests, fetch shims, and cross-realm Request
  // objects can still expose their URL through the structural `url` field.
  if (typeof input === "object" && input && "url" in input && typeof input.url === "string") {
    return input.url;
  }
  return "";
}
