import type { SkillResourceAllocationRecord } from "./skill-resource-allocation-ledger.js";
import {
  skillResourceAllocationAttestation,
  type SkillResourceRuntimeOperation,
} from "./skill-resource-transfer-contract.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";

type CleanupParams = {
  record: SkillResourceAllocationRecord;
  runtimeScript: string;
  tunnel: Pick<WorkerWorkspaceTunnelHandle, "runWorkspaceCommand">;
  assertCurrent: () => void;
};

async function runCleanupOperation(
  params: CleanupParams,
  operation: SkillResourceRuntimeOperation,
) {
  params.assertCurrent();
  const result = await params.tunnel.runWorkspaceCommand({
    argv: ["node", "-e", params.runtimeScript],
    input: JSON.stringify(operation),
    transportRetry: "never",
    assertCurrent: params.assertCurrent,
    timeoutMs: 5000,
  });
  params.assertCurrent();
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error(
      "Skill resource transfer failed. Retry this turn after reconnecting the execution environment.",
      { cause: new Error(result.stderr || "Resource cleanup operation failed") },
    );
  }
}

/** Prepares one durable allocation for cleanup while retaining its receiver-side receipt. */
export async function cleanupSkillResourceAllocation(params: CleanupParams): Promise<void> {
  const { record } = params;
  const operation: SkillResourceRuntimeOperation = record.location
    ? {
        op: "cleanup",
        attestation: skillResourceAllocationAttestation(record.leaseToken),
        id: record.allocationId,
        identity: record.location.identity,
        workspace: record.workspace,
        registryIdentity: record.location.registryIdentity,
        workspaceIdentity: record.location.workspaceIdentity,
      }
    : {
        op: "cleanup-intent",
        attestation: skillResourceAllocationAttestation(record.leaseToken),
        id: record.allocationId,
        workspace: record.workspace,
      };
  await runCleanupOperation(params, operation);
}

/** Finalizes prepared cleanup only after its durable host receipt is committed. */
export async function finalizeSkillResourceAllocationCleanup(params: CleanupParams): Promise<void> {
  const { record } = params;
  if (!record.location) {
    return;
  }
  await runCleanupOperation(params, {
    op: "cleanup-finalize",
    attestation: skillResourceAllocationAttestation(record.leaseToken),
    id: record.allocationId,
    identity: record.location.identity,
    workspace: record.workspace,
    registryIdentity: record.location.registryIdentity,
    workspaceIdentity: record.location.workspaceIdentity,
  });
}
