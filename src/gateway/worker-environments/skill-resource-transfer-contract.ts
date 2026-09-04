import { createHash } from "node:crypto";
import type {
  SkillResourceAllocationIntent,
  SkillResourceAllocationLocation,
  SkillResourceAllocationRecord,
} from "./skill-resource-allocation-ledger.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";
import { WORKER_ATTACHMENT_DIRECTORY_PREFIX } from "./workspace-path-exclusions.js";

export type SkillResourceAllocationOwner = {
  assertOwned(): void;
  createIntent(intent: SkillResourceAllocationIntent): Promise<SkillResourceAllocationRecord>;
  markAllocated(
    record: SkillResourceAllocationRecord,
    location: SkillResourceAllocationLocation,
  ): Promise<SkillResourceAllocationRecord>;
  retire(
    record: SkillResourceAllocationRecord,
    tunnel: Pick<WorkerWorkspaceTunnelHandle, "runWorkspaceCommand">,
    assertCurrent: () => void,
  ): Promise<void>;
};

export type SkillResourceLocation = {
  attestation: string;
  id: string;
  identity: string;
  root: string;
  workspace: string;
  workspaceIdentity: string;
  registryIdentity: string;
};

export type SkillResourceLeaseLocation = Omit<SkillResourceLocation, "root">;

export type SkillResourceRuntimeOperation =
  | { op: "init"; attestation: string; id: string; workspace: string }
  | { op: "cleanup-intent"; attestation: string; id: string; workspace: string }
  | ({ op: "cleanup" } & SkillResourceLeaseLocation)
  | ({ op: "cleanup-finalize" } & SkillResourceLeaseLocation)
  | ({ op: "commit" } & SkillResourceLeaseLocation)
  | ({ op: "renew" } & SkillResourceLeaseLocation)
  | ({
      op: "write";
      name: string;
      offset: number;
      size: number;
      hash: string;
      executable: boolean;
      data: string;
    } & SkillResourceLeaseLocation);

export function skillResourceAllocationAttestation(leaseToken: string): string {
  return createHash("sha256").update(leaseToken).digest("hex");
}

export function skillResourceAllocationDirectoryName(allocationId: string): string {
  const uuid = [
    allocationId.slice(0, 8),
    allocationId.slice(8, 12),
    allocationId.slice(12, 16),
    allocationId.slice(16, 20),
    allocationId.slice(20),
  ].join("-");
  return `${WORKER_ATTACHMENT_DIRECTORY_PREFIX}${uuid}`;
}
