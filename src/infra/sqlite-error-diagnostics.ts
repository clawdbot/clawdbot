import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export function formatSqliteErrorCodeSuffix(error: unknown): string {
  const details = new Set<string>();
  // Preserve native codes through wrappers without exposing cause prose or metadata.
  // The depth cap also bounds cyclic causes; Node's SQLite errcode is a signed int.
  for (let current = error, depth = 0; depth < 8 && isRecord(current); depth += 1) {
    const code = extractErrorCode(current);
    if (code && /^[A-Z0-9_]{1,64}$/u.test(code)) {
      details.add(`code=${code}`);
    }
    const { errcode } = current;
    if (
      typeof errcode === "number" &&
      Number.isInteger(errcode) &&
      errcode >= 0 &&
      errcode <= 0x7fff_ffff
    ) {
      details.add(`errcode=${errcode}`);
    }
    current = current.cause;
  }
  return details.size > 0 ? ` (${[...details].join(", ")})` : "";
}
