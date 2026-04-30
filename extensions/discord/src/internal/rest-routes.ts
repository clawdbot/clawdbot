type QueryValue = string | number | boolean;

export function createRouteKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.split("?")[0] ?? path}`;
}

function readTopLevelRouteKey(path: string): string {
  const [pathname = path] = path.split("?");
  const [first, id, token] = pathname.replace(/^\/+/, "").split("/");
  if (!first || !id) {
    return pathname;
  }
  if (first === "channels" || first === "guilds" || first === "webhooks") {
    return first === "webhooks" && token ? `${first}/${id}/${token}` : `${first}/${id}`;
  }
  return first;
}

export function createBucketKey(bucket: string, path: string): string {
  return `${bucket}:${readTopLevelRouteKey(path)}`;
}

export function readHeaderNumber(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readResetAt(response: Response): number | undefined {
  const resetAfter = readHeaderNumber(response.headers, "X-RateLimit-Reset-After");
  if (resetAfter !== undefined) {
    return Date.now() + Math.max(0, resetAfter * 1000);
  }
  const reset = readHeaderNumber(response.headers, "X-RateLimit-Reset");
  return reset !== undefined ? reset * 1000 : undefined;
}

export function appendQuery(path: string, query?: Record<string, QueryValue>): string {
  if (!query || Object.keys(query).length === 0) {
    return path;
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    search.set(key, String(value));
  }
  return `${path}?${search.toString()}`;
}
