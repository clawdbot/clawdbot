const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const TRANSPORT_OWNED_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "content-length",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
]);

type EdgeAuthShapeIssue = {
  message: string;
  headerName?: string;
};

export function findEdgeAuthIssue(headers: Record<string, unknown>): EdgeAuthShapeIssue | null {
  const entries = Object.entries(headers);
  if (entries.length === 0) {
    return { message: "invalid gateway.remote.edgeAuth: header map must not be empty" };
  }
  const originalNames = new Map<string, string>();
  for (const [headerName] of entries) {
    if (!HTTP_HEADER_NAME_PATTERN.test(headerName)) {
      return {
        headerName,
        message: `invalid gateway.remote.edgeAuth header name: ${JSON.stringify(headerName)}`,
      };
    }
    const normalizedName = headerName.toLowerCase();
    if (TRANSPORT_OWNED_HEADERS.has(normalizedName)) {
      return {
        headerName,
        message: `gateway.remote.edgeAuth cannot set transport-owned header "${headerName}"`,
      };
    }
    const originalName = originalNames.get(normalizedName);
    if (originalName) {
      return {
        headerName,
        message: `gateway.remote.edgeAuth header names "${originalName}" and "${headerName}" differ only by case`,
      };
    }
    originalNames.set(normalizedName, headerName);
  }
  return null;
}
