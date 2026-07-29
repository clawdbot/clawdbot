// Boolean parameter helpers parse plugin-facing string flags into stable booleans.
import { parseBoolean } from "../../packages/normalization-core/src/boolean-coercion.js";

/** Read loose boolean params from tool input that may arrive as booleans or "true"/"false" strings. */
export function readBooleanParam(
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  return parseBoolean(params[key]);
}
