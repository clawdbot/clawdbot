import { describe, expect, it, vi } from "vitest";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import { createRemoteExecPlacementSandbox } from "./placement-sandbox.js";
import type { WorkerEnvironmentService } from "./service.js";

describe("remote-exec placement sandbox", () => {
  it("binds the exact managed worktree and placement generation into the runtime", async () => {
    const environmentId = "worker:environment-1";
    const remoteWorkspaceDir = "/srv/openclaw/workspaces/session-1";
    const placement = {
      state: "active",
      executionMode: "remote-exec",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      agentId: "main",
      generation: 11,
      turnClaim: null,
      createdAtMs: 1,
      updatedAtMs: 2,
      stateChangedAtMs: 2,
      environmentId,
      activeOwnerEpoch: 7,
      workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
      remoteWorkspaceDir,
      workerBundleHash: "a".repeat(64),
      lastTranscriptAckCursor: null,
      lastLiveEventAckCursor: null,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
    } satisfies Extract<WorkerSessionPlacementRecord, { state: "active" }>;
    const environment = {
      environmentId,
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: "provision-1",
      sharedHost: false,
      desktop: null,
      bootstrapReceipt: null,
      ownerEpoch: 7,
      teardownTerminalState: null,
      attachedSessionIds: [placement.sessionId],
      lastError: null,
      createdAtMs: 1,
      updatedAtMs: 2,
      stateChangedAtMs: 2,
      idleSinceAtMs: null,
      destroyRequestedAtMs: null,
      state: "attached",
      leaseId: "lease-1",
      sshEndpoint: {
        host: "worker.example.test",
        port: 2202,
        fallbackPorts: [22],
        user: "worker",
        hostKey: "ssh-ed25519 AAAA",
        keyRef: { source: "file", provider: "worker-keys", id: "/key" },
      },
      desktopAvailable: false,
      desktopApps: [],
      tunnelStatus: "connected",
    } satisfies NonNullable<ReturnType<WorkerEnvironmentService["get"]>>;
    const resolveSshIdentity = vi.fn(async () => ({
      kind: "material" as const,
      contents: "private-key-material",
    }));

    const sandbox = await createRemoteExecPlacementSandbox({
      environments: { get: () => environment, resolveSshIdentity },
      localWorkspaceDir: "/local/managed-worktree",
      placement,
    });

    expect(resolveSshIdentity).toHaveBeenCalledWith(environmentId);
    expect(sandbox).toMatchObject({
      enabled: true,
      placementExecutionMode: "remote-exec",
      backendId: "ssh",
      runtimeId: "remote-exec:worker:environment-1:7:11",
      workspaceDir: "/local/managed-worktree",
      containerWorkdir: remoteWorkspaceDir,
    });
    expect(sandbox.backend?.workdir).toBe(remoteWorkspaceDir);
    expect(sandbox.backend?.workdirRoots).toEqual([remoteWorkspaceDir]);
  });
});
