import { resetAnnounceQueuesForTests } from "./subagent-announce-queue.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function resetSubagentRegistryForTests() {
  subagentRuns.clear();
  resetAnnounceQueuesForTests();
}

export function addSubagentRunForTests(entry: SubagentRunRecord) {
  subagentRuns.set(entry.runId, entry);
}
