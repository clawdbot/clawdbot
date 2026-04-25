const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

function readOwnDataProperty(value: unknown, key: string): unknown {
  if (!isObjectLike(value)) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isHttpStatusCode(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= HTTP_STATUS_MIN &&
    value <= HTTP_STATUS_MAX
  );
}

export function diagnosticErrorCategory(err: unknown): string {
  try {
    if (err instanceof TypeError) {
      return "TypeError";
    }
    if (err instanceof RangeError) {
      return "RangeError";
    }
    if (err instanceof ReferenceError) {
      return "ReferenceError";
    }
    if (err instanceof SyntaxError) {
      return "SyntaxError";
    }
    if (err instanceof URIError) {
      return "URIError";
    }
    if (typeof AggregateError !== "undefined" && err instanceof AggregateError) {
      return "AggregateError";
    }
    if (err instanceof Error) {
      return "Error";
    }
  } catch {
    return "unknown";
  }
  if (err === null) {
    return "null";
  }
  return typeof err;
}

export function diagnosticHttpStatusCode(err: unknown): string | undefined {
  const status = readOwnDataProperty(err, "status");
  if (isHttpStatusCode(status)) {
    return String(status);
  }
  const statusCode = readOwnDataProperty(err, "statusCode");
  if (isHttpStatusCode(statusCode)) {
    return String(statusCode);
  }
  return undefined;
}
