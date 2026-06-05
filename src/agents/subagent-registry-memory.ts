/**
 * Process-local live subagent run map.
 *
 * Shared by registry read/write helpers for active in-memory run state.
 */
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export const subagentRuns = new Map<string, SubagentRunRecord>();
