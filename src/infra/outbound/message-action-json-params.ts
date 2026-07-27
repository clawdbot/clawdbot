// JSON-string message action params are parsed in place before validation.

/** Parses a named string param as JSON for structured message action fields. */
export function parseJsonMessageParam(params: Record<string, unknown>, key: string): void {
  const raw = params[key];
  if (typeof raw !== "string") {
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    delete params[key];
    return;
  }
  try {
    params[key] = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(`--${key} must be valid JSON`);
  }
}

/** Parses the interactive message action param as JSON when provided as a string. */
export function parseInteractiveParam(params: Record<string, unknown>): void {
  const raw = params.interactive;
  if (typeof raw !== "string") {
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    delete params.interactive;
    return;
  }
  try {
    params.interactive = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("--interactive must be valid JSON");
  }
}
