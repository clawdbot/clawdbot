import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";

// Public normalizer alias for persisted subagent and ACP session keys.
export const normalizeSubagentSessionKey = normalizeOptionalString;
