// Shared by the QA mock providers and the fixtures that consume their debug logs.
export function parseQaDebugRequestCursor(value: string): number | null {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    return null;
  }
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) ? cursor : null;
}

export function readQaMockRequestCursor(value: unknown): number {
  const cursor =
    value && typeof value === "object" && !Array.isArray(value) && "cursor" in value
      ? value.cursor
      : undefined;
  if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error("mock provider request cursor response was invalid");
  }
  return cursor;
}

export function qaMockRequestCursorUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/debug/request-cursor`;
}

export function qaMockRequestsAfterUrl(baseUrl: string, cursor: number): string {
  return `${baseUrl.replace(/\/+$/u, "")}/debug/requests?after=${cursor}`;
}
