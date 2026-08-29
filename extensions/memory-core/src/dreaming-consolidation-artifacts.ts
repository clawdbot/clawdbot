// Memory Core plugin module owns consolidation preimages and operator summaries.
import { createHash } from "node:crypto";
import { updateDreamsFile } from "./dreaming-dreams-file.js";
import {
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
  DREAMING_MEMORY_BACKUP_NAMESPACE,
} from "./dreaming-state.js";
import { pruneMemoryEntryOrigins } from "./memory-entry-origins.js";
import { extractPromotionKeys } from "./short-term-promotion-memory-write.js";

const CONSOLIDATION_BACKUP_LIMIT = 8;

type ConsolidationBackup = {
  createdAt: string;
  content: string;
  contentHash: string;
};

export type MemoryConsolidationResult = {
  content: string;
  added: number;
  merged: number;
  superseded: number;
  highlights: string[];
};

export function readMemoryPreimages(workspaceDir: string) {
  return readMemoryCoreWorkspaceEntries<ConsolidationBackup>({
    namespace: DREAMING_MEMORY_BACKUP_NAMESPACE,
    workspaceDir,
  });
}

export async function storeMemoryPreimage(params: {
  workspaceDir: string;
  content: string;
  nowMs: number;
  agentIds: readonly string[];
  retainedEntryKeys: ReadonlySet<string>;
}): Promise<Set<string>> {
  const current = await readMemoryPreimages(params.workspaceDir);
  const createdAt = new Date(params.nowMs).toISOString();
  const contentHash = createHash("sha256").update(params.content).digest("hex");
  const entries = [
    ...current,
    {
      key: `${createdAt}:${contentHash.slice(0, 12)}`,
      value: { createdAt, content: params.content, contentHash },
    },
  ]
    .toSorted((left, right) => left.value.createdAt.localeCompare(right.value.createdAt))
    .slice(-CONSOLIDATION_BACKUP_LIMIT);
  await writeMemoryCoreWorkspaceEntries({
    namespace: DREAMING_MEMORY_BACKUP_NAMESPACE,
    workspaceDir: params.workspaceDir,
    entries,
  });
  const retainedKeys = new Set(entries.flatMap(({ value }) => extractPromotionKeys(value.content)));
  // Rotation releases only expired backup references. The current preimage and
  // staged keys still protect live content if the following MEMORY write fails.
  await pruneMemoryEntryOrigins({
    workspaceDir: params.workspaceDir,
    agentIds: params.agentIds,
    entryKeys: current.flatMap(({ value }) => extractPromotionKeys(value.content)),
    retainedEntryKeys: new Set([...retainedKeys, ...params.retainedEntryKeys]),
  });
  return retainedKeys;
}

export async function appendConsolidationSummary(params: {
  workspaceDir: string;
  result: MemoryConsolidationResult;
  nowMs: number;
}): Promise<void> {
  const timestamp = new Date(params.nowMs).toISOString();
  const lines = [
    `### ${timestamp}`,
    "",
    `- Added: ${params.result.added}`,
    `- Merged: ${params.result.merged}`,
    `- Superseded: ${params.result.superseded}`,
    ...params.result.highlights,
    "",
  ];
  await updateDreamsFile({
    workspaceDir: params.workspaceDir,
    updater: (existing, dreamsPath) => {
      const heading = "## Memory Consolidation History";
      const base = existing.includes(heading)
        ? existing.trimEnd()
        : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${heading}`;
      return {
        content: `${base}\n\n${lines.join("\n")}`,
        result: dreamsPath,
      };
    },
  });
}

export async function appendConsolidationSkippedSummary(params: {
  workspaceDir: string;
  nowMs: number;
  reason: string;
}): Promise<void> {
  const timestamp = new Date(params.nowMs).toISOString();
  await updateDreamsFile({
    workspaceDir: params.workspaceDir,
    updater: (existing, _dreamsPath) => {
      const heading = "## Memory Consolidation History";
      const base = existing.includes(heading)
        ? existing.trimEnd()
        : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${heading}`;
      return {
        content: `${base}\n\n### ${timestamp}\n\n- Rewrite skipped: ${params.reason}.\n- Fallback: append-only promotion.\n`,
        result: undefined,
      };
    },
  });
}
