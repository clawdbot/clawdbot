export function parseTimeoutMs(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  let value = Number.NaN;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "bigint") {
    value = Number(raw);
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    value = Number.parseInt(trimmed, 10);
  }
  return Number.isFinite(value) ? value : undefined;
}

function invalidTimeout(value?: string): Error {
  const suffix = value ? ` Received: "${value}".` : "";
  return new Error(
    `Invalid --timeout. Use a positive millisecond value, e.g. --timeout 30000.${suffix}`,
  );
}

export function parseTimeoutMsWithFallback(
  raw: unknown,
  fallbackMs: number,
  options: {
    invalidType?: "fallback" | "error";
  } = {},
): number {
  if (raw === undefined || raw === null) {
    return fallbackMs;
  }

  const value =
    typeof raw === "string"
      ? raw.trim()
      : typeof raw === "number" || typeof raw === "bigint"
        ? String(raw)
        : null;

  if (value === null) {
    if (options.invalidType === "error") {
      throw invalidTimeout();
    }
    return fallbackMs;
  }

  if (!value) {
    return fallbackMs;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw invalidTimeout(value);
  }
  return parsed;
}
