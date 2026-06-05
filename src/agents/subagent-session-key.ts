/**
 * Public normalizer alias for persisted subagent and ACP session keys.
 * Re-exporting the shared string normalizer keeps session-key call sites
 * decoupled from normalization-core paths.
 */
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";

/** Normalizes a persisted subagent/session key to a trimmed string or undefined. */
export const normalizeSubagentSessionKey = normalizeOptionalString;
