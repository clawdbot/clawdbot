import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import { createRemoteExecPlacementSandbox } from "./placement-sandbox.js";
import type { WorkerEnvironmentService } from "./service.js";

const environmentId = "worker:environment-1";
const remoteWorkspaceDir = "/srv/openclaw/workspaces/session-1";

function remoteExecPlacement() {
  return {
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
}

function attachedEnvironment() {
  return {
    environmentId,
    providerId: "fake",
    profileId: "development",
    profileSnapshot: { settings: { region: "test" } },
    provisionOperationId: "provision-1",
    nodeSetupId: null,
    nodeDeviceId: null,
    sharedHost: false,
    desktop: null,
    bootstrapReceipt: null,
    ownerEpoch: 7,
    teardownTerminalState: null,
    attachedSessionIds: ["session-1"],
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
}

describe("remote-exec placement sandbox", () => {
  it("binds the exact SSH managed worktree and placement generation into the runtime", async () => {
    const placement = remoteExecPlacement();
    const environment = attachedEnvironment();
    const resolveSshIdentity = vi.fn(async () => ({
      kind: "material" as const,
      contents: "private-key-material",
    }));

    const sandbox = await createRemoteExecPlacementSandbox({
      environments: { get: () => environment, resolveSshIdentity },
      workspaceDir: "/local/managed-worktree",
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
    expect(sandbox).not.toHaveProperty("placementEnvironmentId");
    expect(sandbox).not.toHaveProperty("placementSessionId");
    expect(sandbox).not.toHaveProperty("placementOwnerEpoch");
  });

  it.each([
    { platform: "POSIX", nodeWorkspaceDir: remoteWorkspaceDir },
    {
      platform: "Windows",
      nodeWorkspaceDir: path.win32.join(
        "C:\\",
        "Users",
        "Node",
        ".openclaw",
        "node-host",
        "workspaces",
        "session-1",
      ),
    },
  ])(
    "binds an exact $platform paired-node worktree without inventing an SSH backend or filesystem bridge",
    async ({ nodeWorkspaceDir }) => {
      const placement = { ...remoteExecPlacement(), remoteWorkspaceDir: nodeWorkspaceDir };
      const environment = {
        ...attachedEnvironment(),
        providerId: "device",
        nodeDeviceId: "paired-node-1",
        sharedHost: true,
        sshEndpoint: null,
      } satisfies NonNullable<ReturnType<WorkerEnvironmentService["get"]>>;
      const resolveSshIdentity = vi.fn();

      const sandbox = await createRemoteExecPlacementSandbox({
        environments: { get: () => environment, resolveSshIdentity },
        workspaceDir: "/local/managed-worktree",
        placement,
      });

      expect(sandbox).toMatchObject({
        enabled: true,
        placementExecutionMode: "remote-exec",
        placementNodeId: "paired-node-1",
        placementEnvironmentId: environmentId,
        placementSessionId: "session-1",
        placementOwnerEpoch: 7,
        backendId: "node",
        runtimeId: "remote-exec:worker:environment-1:7:11",
        workspaceDir: "/local/managed-worktree",
        containerWorkdir: nodeWorkspaceDir,
      });
      expect(sandbox.backend).toBeUndefined();
      expect(sandbox.fsBridge).toBeUndefined();
      expect(resolveSshIdentity).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "POSIX root", workspaceDir: "/" },
    { label: "Windows root", workspaceDir: "C:\\" },
    { label: "POSIX traversal", workspaceDir: "/srv/../workspace" },
    { label: "Windows traversal", workspaceDir: String.raw`C:\Users\..\workspace` },
    { label: "Windows drive-relative path", workspaceDir: "C:workspace" },
    { label: "Windows rooted path without a drive", workspaceDir: String.raw`\workspace` },
    { label: "Windows UNC path", workspaceDir: String.raw`\\server\share\workspace` },
    { label: "mixed Windows separators", workspaceDir: String.raw`C:\Users/workspace` },
    { label: "POSIX trailing separator", workspaceDir: "/srv/workspace/" },
    { label: "Windows trailing separator", workspaceDir: "C:\\Users\\workspace\\" },
  ])("rejects an ambiguous or noncanonical paired-node $label", async ({ workspaceDir }) => {
    const environment = {
      ...attachedEnvironment(),
      nodeDeviceId: "paired-node-1",
      sshEndpoint: null,
    };

    await expect(
      createRemoteExecPlacementSandbox({
        environments: { get: () => environment },
        workspaceDir: "/local/managed-worktree",
        placement: { ...remoteExecPlacement(), remoteWorkspaceDir: workspaceDir },
      }),
    ).rejects.toThrow("invalid managed workspace path");
  });

  it("rejects Windows workspace paths for the POSIX SSH carrier", async () => {
    const environment = attachedEnvironment();
    const resolveSshIdentity = vi.fn();

    await expect(
      createRemoteExecPlacementSandbox({
        environments: { get: () => environment, resolveSshIdentity },
        workspaceDir: "/local/managed-worktree",
        placement: {
          ...remoteExecPlacement(),
          remoteWorkspaceDir: String.raw`C:\Users\Node\workspace`,
        },
      }),
    ).rejects.toThrow("invalid managed workspace path");
    expect(resolveSshIdentity).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "stale owner epoch",
      mutate: (environment: ReturnType<typeof attachedEnvironment>) => ({
        ...environment,
        ownerEpoch: environment.ownerEpoch + 1,
      }),
    },
    {
      label: "different attached session",
      mutate: (environment: ReturnType<typeof attachedEnvironment>) => ({
        ...environment,
        attachedSessionIds: ["replacement-session"],
      }),
    },
    {
      label: "different SSH endpoint",
      mutate: (environment: ReturnType<typeof attachedEnvironment>) => ({
        ...environment,
        sshEndpoint: { ...environment.sshEndpoint, host: "replacement.example.test" },
      }),
    },
  ])("rejects a $label after awaited SSH identity preparation", async ({ mutate }) => {
    const placement = remoteExecPlacement();
    let environment = attachedEnvironment();
    const resolveSshIdentity = vi.fn(async () => {
      environment = mutate(environment);
      return { kind: "material" as const, contents: "private-key-material" };
    });

    await expect(
      createRemoteExecPlacementSandbox({
        environments: { get: () => environment, resolveSshIdentity },
        workspaceDir: "/local/managed-worktree",
        placement,
      }),
    ).rejects.toThrow("lost its exact environment");
  });

  it.each([
    {
      label: "node identity",
      replacement: { nodeDeviceId: "replacement-node" },
    },
    {
      label: "environment identity",
      replacement: { environmentId: "worker:replacement-environment" },
    },
    {
      label: "owner epoch",
      replacement: { ownerEpoch: 8 },
    },
    {
      label: "session identity",
      replacement: { attachedSessionIds: ["replacement-session"] },
    },
  ])(
    "rejects a paired node's replaced $label before returning its sandbox",
    async ({ replacement }) => {
      const placement = remoteExecPlacement();
      const environment = {
        ...attachedEnvironment(),
        nodeDeviceId: "paired-node-1",
        sshEndpoint: null,
      };
      const get = vi
        .fn<WorkerEnvironmentService["get"]>()
        .mockReturnValueOnce(environment)
        .mockReturnValueOnce({ ...environment, ...replacement });

      await expect(
        createRemoteExecPlacementSandbox({
          environments: { get },
          workspaceDir: "/local/managed-worktree",
          placement,
        }),
      ).rejects.toThrow("lost its exact environment");
    },
  );
});
