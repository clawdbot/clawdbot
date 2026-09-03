import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const SKILL_RESOURCE_ALLOCATION_LEDGER_VERSION = 1;

export type SkillResourceAllocationLocation = {
  identity: string;
  registryIdentity: string;
  workspaceIdentity: string;
};

type SkillResourceAllocationPhase = "intent" | "allocated" | "cleanup-pending" | "cleanup-complete";

export type SkillResourceAllocationRecord = {
  version: typeof SKILL_RESOURCE_ALLOCATION_LEDGER_VERSION;
  revision: number;
  allocationId: string;
  environmentId: string;
  ownerEpoch: number;
  workspace: string;
  leaseToken: string;
  incarnationId: string;
  phase: SkillResourceAllocationPhase;
  createdAtMs: number;
  updatedAtMs: number;
  location: SkillResourceAllocationLocation | null;
};

export type SkillResourceAllocationIntent = Pick<
  SkillResourceAllocationRecord,
  "allocationId" | "environmentId" | "ownerEpoch" | "workspace" | "leaseToken"
>;

const HEX_32_PATTERN = /^[a-f0-9]{32}$/u;
const HEX_64_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTITY_PATTERN = /^\d+:\d+$/u;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).toSorted().join("\0") === [...keys].toSorted().join("\0");
}

function parseLocation(value: unknown): SkillResourceAllocationLocation | null | undefined {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["identity", "registryIdentity", "workspaceIdentity"])
  ) {
    return undefined;
  }
  const { identity, registryIdentity, workspaceIdentity } = value;
  if (
    typeof identity !== "string" ||
    !IDENTITY_PATTERN.test(identity) ||
    typeof registryIdentity !== "string" ||
    !IDENTITY_PATTERN.test(registryIdentity) ||
    typeof workspaceIdentity !== "string" ||
    !IDENTITY_PATTERN.test(workspaceIdentity)
  ) {
    return undefined;
  }
  return { identity, registryIdentity, workspaceIdentity };
}

function hasReachableState(
  phase: SkillResourceAllocationPhase,
  revision: number,
  location: SkillResourceAllocationLocation | null,
): boolean {
  if (phase === "intent") {
    return revision === 1 && location === null;
  }
  if (phase === "allocated") {
    return revision === 2 && location !== null;
  }
  if (phase === "cleanup-pending") {
    return (revision === 2 && location === null) || (revision === 3 && location !== null);
  }
  return (revision === 3 && location === null) || (revision === 4 && location !== null);
}

export function parseSkillResourceAllocationRecord(
  value: unknown,
  isCanonicalAbsolutePath: (value: unknown) => value is string,
  isSafeEnvironmentId: (value: unknown) => value is string,
): SkillResourceAllocationRecord | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "allocationId",
      "createdAtMs",
      "environmentId",
      "incarnationId",
      "leaseToken",
      "location",
      "ownerEpoch",
      "phase",
      "revision",
      "updatedAtMs",
      "version",
      "workspace",
    ])
  ) {
    return undefined;
  }
  const location = parseLocation(value.location);
  const revision = asSafeIntegerInRange(value.revision, { min: 0 });
  const ownerEpoch = asSafeIntegerInRange(value.ownerEpoch, { min: 0 });
  const createdAtMs = asSafeIntegerInRange(value.createdAtMs, { min: 0 });
  const updatedAtMs = asSafeIntegerInRange(value.updatedAtMs, { min: 0 });
  if (
    value.version !== SKILL_RESOURCE_ALLOCATION_LEDGER_VERSION ||
    revision === undefined ||
    typeof value.allocationId !== "string" ||
    !HEX_32_PATTERN.test(value.allocationId) ||
    !isSafeEnvironmentId(value.environmentId) ||
    ownerEpoch === undefined ||
    !isCanonicalAbsolutePath(value.workspace) ||
    typeof value.leaseToken !== "string" ||
    !HEX_64_PATTERN.test(value.leaseToken) ||
    typeof value.incarnationId !== "string" ||
    !HEX_32_PATTERN.test(value.incarnationId) ||
    (value.phase !== "intent" &&
      value.phase !== "allocated" &&
      value.phase !== "cleanup-pending" &&
      value.phase !== "cleanup-complete") ||
    createdAtMs === undefined ||
    updatedAtMs === undefined ||
    updatedAtMs < createdAtMs ||
    location === undefined ||
    !hasReachableState(value.phase, revision, location)
  ) {
    return undefined;
  }
  return {
    version: SKILL_RESOURCE_ALLOCATION_LEDGER_VERSION,
    revision,
    allocationId: value.allocationId,
    environmentId: value.environmentId,
    ownerEpoch,
    workspace: value.workspace,
    leaseToken: value.leaseToken,
    incarnationId: value.incarnationId,
    phase: value.phase,
    createdAtMs,
    updatedAtMs,
    location,
  };
}

export function parseSkillResourceAllocationLocation(
  value: unknown,
): SkillResourceAllocationLocation | null | undefined {
  return parseLocation(value);
}
