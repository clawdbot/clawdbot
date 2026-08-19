import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";

export const SOURCE = {
  agentId: "main",
  sessionId: "source-session",
  sessionKey: "agent:main:dashboard:source",
  environmentId: "source-environment",
  ownerEpoch: 3,
};

export const TARGET = {
  agentId: "main",
  sessionId: "target-session",
  sessionKey: "agent:main:dashboard:target",
  environmentId: "target-environment",
  ownerEpoch: 4,
};

export const PARENT = {
  sessionId: "parent-session",
  sessionKey: "agent:main:dashboard:parent",
};

export const CHILD = {
  agentId: "main",
  sessionId: "spawned-child-session",
  environmentId: "spawned-child-environment",
  ownerEpoch: 5,
};

export const GRANDCHILD = {
  agentId: "main",
  sessionId: "spawned-grandchild-session",
  environmentId: "spawned-grandchild-environment",
  ownerEpoch: 6,
};

export const PARENT_EXECUTION_IDENTITY_TOKEN = {
  tokenVersion: 1,
  contextId: "parent-context",
  executionId: "parent-execution",
  runId: "source-run",
  createdAt: 1,
} satisfies ExecutionIdentityAdmissionToken;

export function activateWorkerSession(
  placements: WorkerSessionPlacementStore,
  session: {
    agentId: string;
    environmentId: string;
    ownerEpoch: number;
    sessionId: string;
    sessionKey: string;
  },
): void {
  let placement = placements.startDispatch(session);
  placement = placements.transition({
    sessionId: session.sessionId,
    from: "requested",
    to: "provisioning",
    expectedGeneration: placement.generation,
    patch: { environmentId: session.environmentId },
  });
  placement = placements.transition({
    sessionId: session.sessionId,
    from: "provisioning",
    to: "syncing",
    expectedGeneration: placement.generation,
    patch: { workerBundleHash: "a".repeat(64) },
  });
  placement = placements.transition({
    sessionId: session.sessionId,
    from: "syncing",
    to: "starting",
    expectedGeneration: placement.generation,
    patch: {
      workspaceBaseManifestRef: `manifest-${session.sessionId}`,
      remoteWorkspaceDir: `/workspace/${session.sessionId}`,
    },
  });
  placements.transition({
    sessionId: session.sessionId,
    from: "starting",
    to: "active",
    expectedGeneration: placement.generation,
    patch: { activeOwnerEpoch: session.ownerEpoch },
  });
}
