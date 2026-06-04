import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Process-local live subagent run map shared by registry read/write helpers. */
export const subagentRuns = new Map<string, SubagentRunRecord>();
