import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";
import { readSkillLifecycleRecord } from "./store-sqlite-lifecycle.js";
import type { SkillWorkshopStoreOptions } from "./store-sqlite-schema.js";
import type { SkillProposalRecord } from "./types.js";

export class SkillProposalStaleTargetError extends Error {}
export class SkillProposalSupersessionIneligibleError extends Error {}

type SkillProposalLifecycleInspection =
  | { ok: true }
  | { ok: false; reason: string; message: string };

export async function inspectSkillProposalLifecycle(
  record: SkillProposalRecord,
  store: SkillWorkshopStoreOptions = {},
): Promise<SkillProposalLifecycleInspection> {
  if (
    record.kind === "update" &&
    readSkillLifecycleRecord(record.target.skillFile, store)?.state === "archived"
  ) {
    return {
      ok: false,
      reason: `Target skill was archived after proposal creation: ${record.target.skillKey}`,
      message: "Target skill was archived after proposal creation; proposal marked stale.",
    };
  }
  for (const source of record.supersedes ?? []) {
    const lifecycle = readSkillLifecycleRecord(source.skillFile, store);
    if (!lifecycle || lifecycle.pinned || lifecycle.state === "archived") {
      return {
        ok: false,
        reason: `Superseded skill is no longer eligible: ${source.skillKey}`,
        message: "Superseded skill is no longer eligible; proposal marked stale.",
      };
    }
    const currentTreeSha256 = await readSkillProposalTargetTreeSha256(source.skillDir).catch(
      () => null,
    );
    if (currentTreeSha256 !== source.treeSha256) {
      return {
        ok: false,
        reason: `Superseded skill changed after proposal creation: ${source.skillKey}`,
        message: "Superseded skill changed after proposal creation; proposal marked stale.",
      };
    }
  }
  return { ok: true };
}
