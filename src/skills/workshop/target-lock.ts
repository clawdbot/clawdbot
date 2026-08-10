import path from "node:path";
import { canonicalizePath } from "../../agents/utils/paths.js";
import { withOpenClawStateLease } from "../../state/openclaw-state-lease.js";
import { hashSkillProposalContent } from "./proposal-hash.js";
import {
  databaseOptions,
  ensureSkillWorkshopSchema,
  type SkillWorkshopStoreOptions,
} from "./store-sqlite-schema.js";
import type { SkillProposalRecord } from "./types.js";

const TARGET_LEASE_MS = 60_000;
const TARGET_LEASE_WAIT_MS = 5_000;

export async function withSkillProposalTargetLock<T>(
  record: SkillProposalRecord,
  fn: () => Promise<T>,
  options: SkillWorkshopStoreOptions = {},
): Promise<T> {
  ensureSkillWorkshopSchema(options);
  const skillFiles = [
    record.target.skillFile,
    ...(record.supersedes ?? []).map((skill) => skill.skillFile),
  ]
    .map((skillFile) => canonicalizePath(path.resolve(skillFile)))
    .filter((skillFile, index, files) => files.indexOf(skillFile) === index)
    .toSorted();
  const acquisitionDeadline = performance.now() + TARGET_LEASE_WAIT_MS;
  const lockNext = async (index: number): Promise<T> => {
    const skillFile = skillFiles[index];
    if (!skillFile) {
      return await fn();
    }
    return await withOpenClawStateLease(
      {
        scope: "skill-workshop-target",
        key: hashSkillProposalContent(skillFile),
        database: { scope: "shared", options: databaseOptions(options) },
        leaseMs: TARGET_LEASE_MS,
        waitMs: Math.max(0, Math.floor(acquisitionDeadline - performance.now())),
        leaseLabel: "Skill Workshop target lease",
        operationLabel: "skill-workshop.target-lease",
      },
      async () => await lockNext(index + 1),
    );
  };
  return await lockNext(0);
}
