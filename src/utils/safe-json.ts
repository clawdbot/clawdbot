/**
 * Defensive JSON stringify helper for diagnostics.
 *
 * The replacer handles values common in runtime logs that JSON.stringify would
 * otherwise reject or erase, and returns null for circular structures.
 */
/** Safely stringify diagnostic values, preserving bigint/errors/functions in readable form. */
export function safeJsonStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") {
        return val.toString();
      }
      if (typeof val === "function") {
        return "[Function]";
      }
      if (val instanceof Error) {
        return { name: val.name, message: val.message, stack: val.stack };
      }
      if (val instanceof Uint8Array) {
        // Binary payloads are base64 encoded so diagnostic JSON remains valid UTF-8 text.
        return { type: "Uint8Array", data: Buffer.from(val).toString("base64") };
      }
      return val;
    });
  } catch {
    return null;
  }
}
