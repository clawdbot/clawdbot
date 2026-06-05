// Subagent registry test helpers expose the in-memory run map for small unit
// tests that do not need persistence, lifecycle hooks, or gateway mocks.
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function resetSubagentRegistryForTests() {
  subagentRuns.clear();
}

export function addSubagentRunForTests(entry: SubagentRunRecord) {
  subagentRuns.set(entry.runId, entry);
}
