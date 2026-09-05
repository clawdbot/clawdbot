import {
  withOpenClawStateLease,
  type OpenClawStateLeaseContext,
} from "../../state/openclaw-state-lease.js";
import { hashSkillProposalContent } from "./proposal-hash.js";
import {
  databaseOptions,
  ensureSkillWorkshopSchema,
  type SkillWorkshopStoreOptions,
} from "./store-sqlite-schema.js";
import type { SkillProposalRecord } from "./types.js";

const TARGET_LEASE_MS = 60_000;
const TARGET_LEASE_WAIT_MS = 5_000;
const COLLECTION_LEASE_MS = 11 * 60_000;

function requireAgentId(options: SkillWorkshopStoreOptions): string {
  if (!options.agentId) {
    throw new Error("Skill Workshop requires an agent id for storage ownership.");
  }
  return options.agentId;
}

/** Each agent owns one collection lease; writers for different agents do not contend. */
export async function withSkillCollectionLock<T>(
  fn: (lease: OpenClawStateLeaseContext) => Promise<T>,
  options: SkillWorkshopStoreOptions = {},
): Promise<T> {
  ensureSkillWorkshopSchema(options);
  return await withOpenClawStateLease(
    {
      scope: "skill-collection",
      key: requireAgentId(options),
      database: { scope: "shared", options: databaseOptions(options) },
      leaseMs: COLLECTION_LEASE_MS,
      waitMs: TARGET_LEASE_WAIT_MS,
      leaseLabel: "skill collection review claim",
      operationLabel: "skill-collection.review",
    },
    fn,
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
      key: `${requireAgentId(options)}:${hashSkillProposalContent(record.target.skillFile)}`,
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
  record: SkillProposalRecord,
  fn: () => Promise<T>,
  options: SkillWorkshopStoreOptions = {},
): Promise<T> {
  return await withSkillCollectionLock(
    async () => await withSkillProposalTargetLock(record, fn, options),
    options,
  );
}
