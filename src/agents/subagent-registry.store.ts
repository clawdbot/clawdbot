import path from "node:path";

import { STATE_DIR_CLAWDBOT } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import type { SubagentRunRecord } from "./subagent-registry.js";

export type PersistedSubagentRegistryVersion = 1;

type PersistedSubagentRegistry = {
  version: 1;
  runs: Record<string, PersistedSubagentRunRecord>;
};

const REGISTRY_VERSION = 1 as const;

type PersistedSubagentRunRecord = Omit<SubagentRunRecord, "announceHandled">;

export function resolveSubagentRegistryPath(): string {
  return path.join(STATE_DIR_CLAWDBOT, "subagents", "runs.json");
}

export function loadSubagentRegistryFromDisk(): Map<string, SubagentRunRecord> {
  const pathname = resolveSubagentRegistryPath();
  const raw = loadJsonFile(pathname);
  if (!raw || typeof raw !== "object") return new Map();
  const record = raw as Partial<PersistedSubagentRegistry>;
  if (record.version !== REGISTRY_VERSION) return new Map();
  const runsRaw = record.runs;
  if (!runsRaw || typeof runsRaw !== "object") return new Map();
  const out = new Map<string, SubagentRunRecord>();
  for (const [runId, entry] of Object.entries(runsRaw)) {
    if (!entry || typeof entry !== "object") continue;
    const typed = entry as PersistedSubagentRunRecord;
    if (!typed.runId || typeof typed.runId !== "string") continue;
    const announceCompletedAt =
      typeof typed.announceCompletedAt === "number"
        ? typed.announceCompletedAt
        : undefined;
    out.set(runId, {
      ...typed,
      announceCompletedAt,
      announceHandled: Boolean(announceCompletedAt),
    });
  }
  return out;
}

export function saveSubagentRegistryToDisk(
  runs: Map<string, SubagentRunRecord>,
) {
  const pathname = resolveSubagentRegistryPath();
  const serialized: Record<string, PersistedSubagentRunRecord> = {};
  for (const [runId, entry] of runs.entries()) {
    const { announceHandled: _ignored, ...persisted } = entry;
    serialized[runId] = persisted;
  }
  const out: PersistedSubagentRegistry = {
    version: REGISTRY_VERSION,
    runs: serialized,
  };
  saveJsonFile(pathname, out);
}
