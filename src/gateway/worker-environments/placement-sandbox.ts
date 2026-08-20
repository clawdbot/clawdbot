import path from "node:path";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { createSandboxFsBridge } from "../../agents/sandbox/fs-bridge.js";
import { createPreprovisionedSshSandboxBackend } from "../../agents/sandbox/ssh-backend.js";
import type { SandboxConfig, SandboxContext } from "../../agents/sandbox/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerEnvironmentService } from "./service.js";
import { resolveWorkerSshSandboxSettings } from "./ssh.js";

type ActiveRemoteExecPlacement = Extract<WorkerSessionPlacementRecord, { state: "active" }>;

type PlacementSandboxEnvironmentService = Pick<
  WorkerEnvironmentService,
  "get" | "resolveSshIdentity"
>;

function requireRemoteWorkspaceDir(value: string): string {
  if (
    !path.posix.isAbsolute(value) ||
    value === "/" ||
    path.posix.normalize(value) !== value ||
    value.endsWith("/")
  ) {
    throw new Error("Remote-exec placement has an invalid managed workspace path");
  }
  return value;
}

/** Builds the SSH sandbox owned by one exact active placement generation. */
export async function createRemoteExecPlacementSandbox(params: {
  config?: OpenClawConfig;
  environments: PlacementSandboxEnvironmentService;
  localWorkspaceDir: string;
  placement: ActiveRemoteExecPlacement;
}): Promise<SandboxContext & { placementExecutionMode: "remote-exec" }> {
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
    !environment.sshEndpoint
  ) {
    throw new Error(
      `Remote-exec placement ${placement.sessionId} has no matching active SSH environment`,
    );
  }

  const identity = await params.environments.resolveSshIdentity(environment.environmentId);
  const ssh = resolveWorkerSshSandboxSettings({ ssh: environment.sshEndpoint, identity });
  const remoteWorkspaceDir = requireRemoteWorkspaceDir(placement.remoteWorkspaceDir);
  const runtimeId = [
    "remote-exec",
    environment.environmentId,
    environment.ownerEpoch,
    placement.generation,
  ].join(":");
  const base = resolveSandboxConfigForAgent(params.config, placement.agentId);
  const { binds: _ignoredBinds, ...docker } = base.docker;
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
  const sandbox: SandboxContext & { placementExecutionMode: "remote-exec" } = {
    enabled: true,
    placementExecutionMode: "remote-exec",
    backendId: "ssh",
    sessionKey: placement.sessionKey,
    workspaceDir: params.localWorkspaceDir,
    agentWorkspaceDir: params.localWorkspaceDir,
    workspaceAccess: "rw",
    runtimeId,
    runtimeLabel: runtimeId,
    containerName: runtimeId,
    containerWorkdir: remoteWorkspaceDir,
    docker: cfg.docker,
    tools: cfg.tools,
    browserAllowHostControl: false,
    backend,
  };
  sandbox.fsBridge = backend.createFsBridge?.({ sandbox }) ?? createSandboxFsBridge({ sandbox });
  return sandbox;
}
