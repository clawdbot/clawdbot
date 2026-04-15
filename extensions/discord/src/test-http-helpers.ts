export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

export function urlToString(url: Request | URL | string): string {
  if (typeof url === "string") {
    return url;
  }
  return "url" in url ? url.url : String(url);
}
