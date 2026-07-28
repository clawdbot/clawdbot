const HTTP_URL_PREFIX_RE = /^https?:\/\//i;

function parseUrl(value: string | URL): URL | null {
  if (value instanceof URL) {
    return value;
  }
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function hasHttpUrlPrefix(value: string): boolean {
  return HTTP_URL_PREFIX_RE.test(value);
}

export function isHttpUrl(value: string | URL): boolean {
  const url = parseUrl(value);
  return url?.protocol === "http:" || url?.protocol === "https:";
}

export function isHttpsUrl(value: string | URL): boolean {
  return parseUrl(value)?.protocol === "https:";
}

export function isWebSocketUrl(value: string | URL): boolean {
  const url = parseUrl(value);
  return url?.protocol === "ws:" || url?.protocol === "wss:";
}
