import {
  loadSubagentRegistryFromDisk,
  saveSubagentRegistryToDisk,
} from "./subagent-registry.store.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function persistSubagentRunsToDisk(runs: Map<string, SubagentRunRecord>) {
  try {
    saveSubagentRegistryToDisk(runs);
  } catch {
    // ignore persistence failures
  }
}

export function persistSubagentRunsToDiskOrThrow(runs: Map<string, SubagentRunRecord>) {
  saveSubagentRegistryToDisk(runs);
}

export function restoreSubagentRunsFromDisk(params: {
  runs: Map<string, SubagentRunRecord>;
  mergeOnly?: boolean;
}) {
  const restored = loadSubagentRegistryFromDisk();
  if (restored.size === 0) {
    return 0;
  }
  let added = 0;
  for (const [runId, entry] of restored.entries()) {
    if (!runId || !entry) {
      continue;
    }
    if (params.mergeOnly && params.runs.has(runId)) {
      continue;
    }
    params.runs.set(runId, entry);
    added += 1;
  }
  return added;
}

export function getSubagentRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  const merged = new Map<string, SubagentRunRecord>();
  const shouldReadDisk =
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK === "1" ||
    !(process.env.VITEST || process.env.NODE_ENV === "test");
  if (shouldReadDisk) {
    try {
      // Persisted state lets other worker processes observe active runs.
      for (const [runId, entry] of loadSubagentRegistryFromDisk().entries()) {
        merged.set(runId, entry);
      }
    } catch {
      // Ignore disk read failures and fall back to local memory.
    }
  }
  for (const [runId, entry] of inMemoryRuns.entries()) {
    merged.set(runId, entry);
  }
  return merged;
}
