// Structural formatting stays policy-free. Core and memory-host adapters intentionally inject
// owner-specific redactors; bypassing them would weaken redaction and break one-argument APIs.
export type FormatErrorMessageOptions = {
  includeCode?: boolean;
  redact: (text: string) => string;
};

const STRUCTURED_ERROR_OWNED_FIELDS = new Set(["cause", "message", "name", "stack"]);
const STRUCTURED_ERROR_PROTOTYPE_FIELDS = new Set(["__proto__", "constructor", "prototype"]);

function readProperty(value: object, key: "cause" | "code" | "status"): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function formatStatusAndCode(value: unknown): string | undefined {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return undefined;
  }
  try {
    if (Object.keys(value).some((key) => key !== "status" && key !== "code")) {
      return undefined;
    }
  } catch {
    // Proxy enumeration can fail; retain the safe status/code fallback below.
  }
  const statusValue = readProperty(value, "status");
  const codeValue = readProperty(value, "code");
  if (statusValue === undefined && codeValue === undefined) {
    return undefined;
  }
  const statusText =
    typeof statusValue === "string" || typeof statusValue === "number"
      ? String(statusValue)
      : "unknown";
  const codeText =
    typeof codeValue === "string" || typeof codeValue === "number" ? String(codeValue) : "unknown";
  return `status=${statusText} code=${codeText}`;
}

function stringifyUnknown(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) {
      return json;
    }
  } catch {
    // Fall through to the stable object tag below.
  }
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return "Unknown error";
  }
}

/** Formats unknown errors with cause details, structured codes, and secret redaction. */
export function formatErrorMessage(value: unknown, options: FormatErrorMessageOptions): string {
  let formatted: string;
  if (value instanceof Error) {
    formatted = value.message || value.name || "Error";
    let cause = readProperty(value, "cause");
    const seen = new Set<unknown>([value]);
    const seenMessages = new Set<string>([formatted]);
    const appendCauseMessage = (message: string | undefined): void => {
      if (!message || seenMessages.has(message)) {
        return;
      }
      formatted += ` | ${message}`;
      seenMessages.add(message);
    };
    // Wrappers routinely embed the cause verbatim ("failed to parse X: <cause.message>"),
    // which exact-match dedupe misses, so the whole sentence prints twice. Codes stay on
    // their own: a trailing bare code is this formatter's convention even when the detail
    // already names it.
    const appendCauseErrorMessage = (message: string | undefined): void => {
      if (message && formatted.includes(message)) {
        seenMessages.add(message);
        return;
      }
      appendCauseMessage(message);
    };
    if (options.includeCode) {
      const code = readProperty(value, "code");
      if (typeof code === "string" || typeof code === "number") {
        appendCauseMessage(String(code));
      }
    }
    while (cause && !seen.has(cause)) {
      seen.add(cause);
      if (cause instanceof Error) {
        appendCauseErrorMessage(cause.message);
        const code = readProperty(cause, "code");
        if (typeof code === "string" || typeof code === "number") {
          appendCauseMessage(String(code));
        }
        cause = readProperty(cause, "cause");
      } else if (typeof cause === "string") {
        appendCauseMessage(cause);
        break;
      } else {
        // Mirror the top-level branch: an object cause with keys beyond
        // status/code makes formatStatusAndCode return undefined, so fall
        // back to stringifyUnknown rather than dropping the cause entirely.
        appendCauseMessage(formatStatusAndCode(cause) ?? stringifyUnknown(cause));
        break;
      }
    }
  } else {
    formatted = formatStatusAndCode(value) ?? stringifyUnknown(value);
  }
  return options.redact(formatted);
}

/**
 * Normalizes an unknown thrown value into an Error. Non-Error objects become
 * the `cause` and have their enumerable fields copied so structured details
 * (codes, statuses) survive the coercion.
 */
export function toErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}

/** Preserves structured details while isolating hostile object field access. */
export function toStructuredErrorObject(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  const message = String(value);
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return toErrorObject(value, message);
  }
  const error = new Error(message, { cause: value });
  try {
    const detailKeys = Reflect.ownKeys(value).filter(
      (key) =>
        (typeof key !== "string" ||
          (!STRUCTURED_ERROR_OWNED_FIELDS.has(key) &&
            !STRUCTURED_ERROR_PROTOTYPE_FIELDS.has(key))) &&
        Reflect.getOwnPropertyDescriptor(value, key)?.enumerable,
    );
    for (const key of detailKeys) {
      try {
        Object.defineProperty(error, key, {
          value: Reflect.get(value, key),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } catch {
        // Skip fields whose getters or property definitions reject access.
      }
    }
  } catch {
    // Opaque proxies may reject enumeration; preserve the original failure as the cause.
  }
  return error;
}

/** Preserves Error values and stringifies every other value into a new Error. */
export function toStringifiedError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Reads Error messages unchanged and stringifies every other value. */
export function coerceErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** Renders a non-Error cause as useful text without throwing. */
export function stringifyNonErrorCause(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
