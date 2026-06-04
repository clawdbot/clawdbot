// Minimal HTTP test fixtures for fetch/provider tests. They keep Response and
// Request normalization consistent across tests without pulling in server code.
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Normalize fetch inputs back to a URL string for assertions in mocked fetches.
export function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

// Test helpers only support string request bodies; absent/non-string bodies use
// an empty JSON object so assertions stay deterministic.
export function requestBodyText(body: BodyInit | null | undefined): string {
  return typeof body === "string" ? body : "{}";
}
