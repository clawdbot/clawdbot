// Account id helpers normalize routing account identifiers for utility callers.
import { normalizeOptionalAccountId } from "../routing/account-id.js";

/**
 * Compatibility wrapper for account-id normalization.
 *
 * Runtime code imports this utility when it needs the older utils path while
 * the canonical normalization logic lives in routing/account-id.
 */
/** Normalize an optional account id, returning undefined for blank/invalid input. */
export function normalizeAccountId(value?: string): string | undefined {
  return normalizeOptionalAccountId(value);
}
