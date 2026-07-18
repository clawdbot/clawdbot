const MAX_ERROR_BODY_LENGTH = 4000;

type HttpErrorShape = Error & {
  status?: unknown;
  statusCode?: unknown;
  body?: unknown;
  error?: unknown;
  response?: {
    status?: unknown;
    statusCode?: unknown;
    body?: unknown;
    data?: unknown;
  };
};

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function readStatus(error: HttpErrorShape): number | undefined {
  for (const value of [
    error.status,
    error.statusCode,
    error.response?.status,
    error.response?.statusCode,
  ]) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function readBody(error: HttpErrorShape): string | undefined {
  for (const value of [error.body, error.error, error.response?.body, error.response?.data]) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
      continue;
    }
    const body = (typeof value === "string" ? value : stringify(value)).trim();
    if (body.length > 0) {
      return body.length <= MAX_ERROR_BODY_LENGTH
        ? body
        : `${body.slice(0, MAX_ERROR_BODY_LENGTH)}... [truncated]`;
    }
  }
  return undefined;
}

export function formatProviderError(error: unknown): string {
  if (!(error instanceof Error)) {
    return stringify(error);
  }

  const httpError = error as HttpErrorShape;
  const status = readStatus(httpError);
  const body = readBody(httpError);
  if (status === undefined || body === undefined || error.message.includes(body)) {
    return error.message;
  }
  return `${status}: ${body}`;
}
