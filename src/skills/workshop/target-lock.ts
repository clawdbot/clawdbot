import { withOpenClawStateLease } from "../../state/openclaw-state-lease.js";
import { canonicalSkillCollectionWorkspace } from "./collection-paths.js";
import { hashSkillProposalContent } from "./proposal-hash.js";
import {
  databaseOptions,
  ensureSkillWorkshopSchema,
  type SkillWorkshopStoreOptions,
} from "./store-sqlite-schema.js";
import type { SkillProposalRecord } from "./types.js";

const TARGET_LEASE_MS = 60_000;
const TARGET_LEASE_WAIT_MS = 5_000;
const COLLECTION_LEASE_MS = 10 * 60_000;

export async function withSkillCollectionLock<T>(
  workspaceDir: string,
  fn: () => Promise<T>,
  options: SkillWorkshopStoreOptions = {},
): Promise<T> {
  ensureSkillWorkshopSchema(options);
  return await withOpenClawStateLease(
    {
      scope: "skill-collection",
      key: hashSkillProposalContent(canonicalSkillCollectionWorkspace(workspaceDir)),
      database: { scope: "shared", options: databaseOptions(options) },
      leaseMs: COLLECTION_LEASE_MS,
      waitMs: TARGET_LEASE_WAIT_MS,
      leaseLabel: "skill collection lease",
      operationLabel: "skill-collection.commit",
    },
    async () => await fn(),
  );
}

export async function withSkillProposalTargetLock<T>(
  record: SkillProposalRecord,
  fn: () => Promise<T>,
  options: SkillWorkshopStoreOptions = {},
): Promise<T> {
  ensureSkillWorkshopSchema(options);
  return await withOpenClawStateLease(
    {
      scope: "skill-workshop-target",
      key: hashSkillProposalContent(record.target.skillFile),
      database: { scope: "shared", options: databaseOptions(options) },
      leaseMs: TARGET_LEASE_MS,
      waitMs: TARGET_LEASE_WAIT_MS,
      leaseLabel: "Skill Workshop target lease",
      operationLabel: "skill-workshop.target-lease",
    },
    async () => await fn(),
  );
}

export async function withSkillProposalCommitLock<T>(
  workspaceDir: string,
  record: SkillProposalRecord,
  fn: () => Promise<T>,
  options: SkillWorkshopStoreOptions = {},
): Promise<T> {
  return await withSkillCollectionLock(
    workspaceDir,
    async () => await withSkillProposalTargetLock(record, fn, options),
    options,
  );
}
