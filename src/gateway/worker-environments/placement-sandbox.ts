import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { createSandboxFsBridge } from "../../agents/sandbox/fs-bridge.js";
import { createPreprovisionedSshSandboxBackend } from "../../agents/sandbox/ssh-backend.js";
import type { SandboxConfig, SandboxContext } from "../../agents/sandbox/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerEnvironmentService } from "./service.js";
import { resolveWorkerSshSandboxSettings } from "./ssh.js";

type ActiveRemoteExecPlacement = Extract<WorkerSessionPlacementRecord, { state: "active" }>;

type PlacementSandboxEnvironmentService = Pick<WorkerEnvironmentService, "get"> &
  Partial<Pick<WorkerEnvironmentService, "resolveSshIdentity">>;

type RemoteExecPlacementSandbox = SandboxContext & {
  placementExecutionMode: "remote-exec";
} & (
    | {
        backendId: "node";
        placementNodeId: string;
        placementEnvironmentId: string;
        placementSessionId: string;
        placementOwnerEpoch: number;
      }
    | {
        backendId: "ssh";
        placementNodeId?: never;
        placementEnvironmentId?: never;
        placementSessionId?: never;
        placementOwnerEpoch?: never;
      }
  );

function requireRemoteWorkspaceDir(value: string, nodeCarrier: boolean): string {
  // Paired nodes report their own native paths, which can differ from the Gateway platform.
  const windowsPath = nodeCarrier && /^[A-Za-z]:/u.test(value) && value[2] === "\\";
  const remotePath = windowsPath ? path.win32 : path.posix;
  if (
    !remotePath.isAbsolute(value) ||
    remotePath.parse(value).root === value ||
    remotePath.normalize(value) !== value ||
    value.endsWith(remotePath.sep) ||
    (nodeCarrier && (windowsPath ? value.includes("/") : value.includes("\\")))
  ) {
    throw new Error("Remote-exec placement has an invalid managed workspace path");
  }
  return value;
}

/** Builds the node or SSH sandbox owned by one exact active placement generation. */
export async function createRemoteExecPlacementSandbox(params: {
  config?: OpenClawConfig;
  environments: PlacementSandboxEnvironmentService;
  localWorkspaceDir: string;
  placement: ActiveRemoteExecPlacement;
}): Promise<RemoteExecPlacementSandbox> {
  const { placement } = params;
  if (placement.executionMode !== "remote-exec") {
    throw new Error(`Cloud placement ${placement.sessionId} is not a remote-exec placement`);
  }
  const environment = params.environments.get(placement.environmentId);
  if (
    !environment ||
    environment.state !== "attached" ||
    environment.environmentId !== placement.environmentId ||
    environment.ownerEpoch !== placement.activeOwnerEpoch ||
    environment.attachedSessionIds.length !== 1 ||
    environment.attachedSessionIds[0] !== placement.sessionId ||
    !environment.leaseId ||
    Boolean(environment.nodeDeviceId) === Boolean(environment.sshEndpoint)
  ) {
    throw new Error(
      `Remote-exec placement ${placement.sessionId} has no matching active node or SSH environment`,
    );
  }

  const assertCurrentEnvironment = () => {
    const current = params.environments.get(environment.environmentId);
    if (
      current?.state !== "attached" ||
      current.environmentId !== environment.environmentId ||
      current.ownerEpoch !== environment.ownerEpoch ||
      current.leaseId !== environment.leaseId ||
      current.nodeDeviceId !== environment.nodeDeviceId ||
      !isDeepStrictEqual(current.sshEndpoint, environment.sshEndpoint) ||
      current.attachedSessionIds.length !== 1 ||
      current.attachedSessionIds[0] !== placement.sessionId
    ) {
      throw new Error(`Remote-exec placement ${placement.sessionId} lost its exact environment`);
    }
  };
  const remoteWorkspaceDir = requireRemoteWorkspaceDir(
    placement.remoteWorkspaceDir,
    Boolean(environment.nodeDeviceId),
  );
  const runtimeId = [
    "remote-exec",
    environment.environmentId,
    environment.ownerEpoch,
    placement.generation,
  ].join(":");
  const base = resolveSandboxConfigForAgent(params.config, placement.agentId);
  const { binds: _ignoredBinds, ...docker } = base.docker;
  const common = {
    enabled: true,
    placementExecutionMode: "remote-exec" as const,
    sessionKey: placement.sessionKey,
    workspaceDir: params.localWorkspaceDir,
    agentWorkspaceDir: params.localWorkspaceDir,
    workspaceAccess: "rw" as const,
    runtimeId,
    runtimeLabel: runtimeId,
    containerName: runtimeId,
    containerWorkdir: remoteWorkspaceDir,
    docker,
    tools: base.tools,
    browserAllowHostControl: false,
  };
  if (environment.nodeDeviceId) {
    // Node workspace ownership already belongs to the placement; JSON-RPC is its execution seam.
    assertCurrentEnvironment();
    return {
      ...common,
      backendId: "node",
      placementNodeId: environment.nodeDeviceId,
      placementEnvironmentId: environment.environmentId,
      placementSessionId: placement.sessionId,
      placementOwnerEpoch: environment.ownerEpoch,
    };
  }
  const sshEndpoint = environment.sshEndpoint;
  const resolveSshIdentity = params.environments.resolveSshIdentity;
  if (!sshEndpoint || !resolveSshIdentity) {
    throw new Error("Remote-exec SSH sandbox identity resolver is unavailable");
  }
  const identity = await resolveSshIdentity(environment.environmentId);
  assertCurrentEnvironment();
  const ssh = resolveWorkerSshSandboxSettings({ ssh: sshEndpoint, identity });
  const cfg: SandboxConfig = {
    ...base,
    mode: "all",
    backend: "ssh",
    scope: "session",
    workspaceAccess: "rw",
    docker,
    ssh: {
      ...base.ssh,
      ...ssh,
      workspaceRoot: path.posix.dirname(remoteWorkspaceDir),
    },
    browser: { ...base.browser, enabled: false, allowHostControl: false },
    prune: { idleHours: 0, maxAgeDays: 0 },
  };
  const backend = await createPreprovisionedSshSandboxBackend(
    {
      sessionKey: placement.sessionKey,
      scopeKey: placement.sessionKey,
      workspaceDir: params.localWorkspaceDir,
      agentWorkspaceDir: params.localWorkspaceDir,
      cfg,
    },
    { runtimeId, remoteWorkspaceDir },
  );
  assertCurrentEnvironment();
  const sandbox: RemoteExecPlacementSandbox = { ...common, backendId: "ssh", backend };
  sandbox.fsBridge = backend.createFsBridge?.({ sandbox }) ?? createSandboxFsBridge({ sandbox });
  return sandbox;
}
