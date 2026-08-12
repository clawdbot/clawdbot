import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/config.js";
import type { SandboxFsBridge } from "../../sandbox/fs-bridge.types.js";
import {
  buildSandboxFsMounts,
  resolveWritableSandboxHostPathAliases,
  type SandboxResolvedFsPath,
} from "../../sandbox/fs-paths.js";
import { resolveSandboxAgentId } from "../../sandbox/shared.js";
import type { SandboxContext } from "../../sandbox/types.js";
import { getSubagentSpawnDeps } from "./subagent-spawn-deps.js";

export type SubagentAttachmentStagingBoundary = {
  workspaceDir?: string;
  sandboxFsBridge?: SandboxFsBridge;
  sandboxAttachmentsRootDir?: string;
  sandboxOwner?: {
    sessionKey: string;
    agentId: string;
    workspaceDir: string;
    identity: {
      backendId: string;
      runtimeId: string;
      configLabel: string;
      fsCleanupLocator?: unknown;
      workspaceMutationVisibility: "shared-host" | "runtime-local";
    };
  };
};

type ResolvedSandboxOwner = {
  sessionKey: string;
  agentId: string;
  workspaceDir: string;
  sandbox: SandboxContext;
};

function resolveWritableSharedHostTargets(
  owner: ResolvedSandboxOwner,
  hostRoot: string,
  relativePath: string,
): SandboxResolvedFsPath[] {
  const sandbox = owner.sandbox;
  if (sandbox.backend?.capabilities?.workspaceMutationVisibility !== "shared-host") {
    return [];
  }
  return resolveWritableSandboxHostPathAliases({
    hostRoot,
    relativePath,
    defaultContainerRoot: sandbox.containerWorkdir,
    mounts: buildSandboxFsMounts(sandbox),
  });
}

function resolveSandboxConfigLabel(sandbox: SandboxContext): string {
  const configLabel = sandbox.backend?.configLabel?.trim();
  if (!configLabel) {
    throw new Error("sandbox backend does not expose a durable runtime identity");
  }
  return configLabel;
}

async function buildBridgeBoundary(params: {
  owner: ResolvedSandboxOwner;
  workspaceDir: string;
  sandboxFsBridge: SandboxFsBridge;
  sandboxAttachmentsRootDir: string;
  workspaceMutationVisibility: "shared-host" | "runtime-local";
  config: OpenClawConfig;
  fsCleanupLocator?: unknown;
  cleanupContainerWorkspaceDir?: string;
}): Promise<SubagentAttachmentStagingBoundary> {
  const { owner } = params;
  const manager = getSubagentSpawnDeps().getSandboxBackendManager(owner.sandbox.backendId);
  const fsCleanupLocator =
    params.fsCleanupLocator ??
    (params.workspaceMutationVisibility === "runtime-local"
      ? await manager?.prepareFsCleanupLocator?.({
          backend: owner.sandbox.backend!,
          runtimeId: owner.sandbox.runtimeId,
          containerWorkspaceDir:
            params.cleanupContainerWorkspaceDir ?? owner.sandbox.containerWorkdir,
          config: params.config,
          agentId: owner.agentId,
        })
      : undefined);
  if (
    params.workspaceMutationVisibility === "runtime-local" &&
    (fsCleanupLocator === undefined || !manager?.createFsCleanupBridge)
  ) {
    throw new Error("sandbox backend does not expose durable filesystem cleanup");
  }
  const cleanupBridge =
    params.workspaceMutationVisibility === "runtime-local"
      ? await manager!.createFsCleanupBridge!({
          runtimeId: owner.sandbox.runtimeId,
          workspaceDir: owner.workspaceDir,
          containerWorkspaceDir:
            params.cleanupContainerWorkspaceDir ?? owner.sandbox.containerWorkdir,
          locator: fsCleanupLocator,
          config: params.config,
          agentId: owner.agentId,
        })
      : params.sandboxFsBridge;
  if (!cleanupBridge) {
    throw new Error("sandbox backend could not bind attachment ingress to the live runtime");
  }
  const sandboxAttachmentsRootDir = cleanupBridge.resolvePath({
    filePath: params.sandboxAttachmentsRootDir,
  }).containerPath;
  return {
    workspaceDir: params.workspaceDir,
    sandboxFsBridge: cleanupBridge,
    sandboxAttachmentsRootDir,
    sandboxOwner: {
      sessionKey: owner.sessionKey,
      agentId: owner.agentId,
      workspaceDir: owner.workspaceDir,
      identity: {
        backendId: owner.sandbox.backendId,
        runtimeId: owner.sandbox.runtimeId,
        configLabel: resolveSandboxConfigLabel(owner.sandbox),
        fsCleanupLocator,
        workspaceMutationVisibility: params.workspaceMutationVisibility,
      },
    },
  };
}

export async function resolveSubagentAttachmentStagingBoundary(params: {
  config: OpenClawConfig;
  targetAgentId: string;
  childSessionKey: string;
  workspaceDir?: string;
  requesterSandboxed: boolean;
  requesterAgentId: string;
  requesterSessionKey: string;
  requesterWorkspaceDir?: string;
}): Promise<SubagentAttachmentStagingBoundary> {
  const deps = getSubagentSpawnDeps();
  const childSandbox = await deps.resolveSandboxContext({
    config: params.config,
    agentId: params.targetAgentId,
    sessionKey: params.childSessionKey,
    workspaceDir: params.workspaceDir,
    requireCurrentConfig: true,
  });
  if (!childSandbox) {
    throw new Error("child sandbox context was unavailable");
  }
  const workspaceDir = childSandbox.workspaceDir ?? params.workspaceDir;
  if (!workspaceDir) {
    throw new Error("child sandbox workspace was unavailable");
  }
  const childOwner: ResolvedSandboxOwner = {
    sessionKey: params.childSessionKey,
    agentId: params.targetAgentId,
    workspaceDir,
    sandbox: childSandbox,
  };
  if (childSandbox.backend?.capabilities?.workspaceMutationVisibility !== "shared-host") {
    const sandboxFsBridge = deps.createSandboxWorkspaceIngressFsBridge(childSandbox);
    const sandboxAttachmentsRootDir = sandboxFsBridge.resolvePath({
      filePath: path.join(workspaceDir, ".openclaw", "attachments"),
    }).containerPath;
    return await buildBridgeBoundary({
      owner: childOwner,
      workspaceDir,
      sandboxFsBridge,
      sandboxAttachmentsRootDir,
      workspaceMutationVisibility: "runtime-local",
      config: params.config,
    });
  }

  const sharedOwnersByRuntime = new Map<string, ResolvedSandboxOwner>();
  const addSharedOwner = (owner: ResolvedSandboxOwner) => {
    sharedOwnersByRuntime.set(`${owner.sandbox.backendId}\0${owner.sandbox.runtimeId}`, owner);
  };
  for (const sandbox of deps.listResolvedSandboxContexts()) {
    const cachedWorkspaceDir = sandbox.workspaceDir;
    if (!cachedWorkspaceDir) {
      continue;
    }
    const cachedAgentId = resolveSandboxAgentId(sandbox.sessionKey);
    if (!cachedAgentId) {
      continue;
    }
    addSharedOwner({
      sessionKey: sandbox.sessionKey,
      agentId: cachedAgentId,
      workspaceDir: cachedWorkspaceDir,
      sandbox,
    });
  }
  addSharedOwner(childOwner);
  if (params.requesterSandboxed) {
    const requesterSandbox = await deps.resolveSandboxContext({
      config: params.config,
      agentId: params.requesterAgentId,
      sessionKey: params.requesterSessionKey,
      workspaceDir: params.requesterWorkspaceDir,
      requireCurrentConfig: true,
    });
    if (!requesterSandbox) {
      throw new Error("requester sandbox context was unavailable");
    }
    addSharedOwner({
      sessionKey: params.requesterSessionKey,
      agentId: params.requesterAgentId,
      workspaceDir: requesterSandbox.workspaceDir,
      sandbox: requesterSandbox,
    });
  }
  const sharedOwners = [...sharedOwnersByRuntime.values()];

  const attachmentsRelativePath = path.join(".openclaw", "attachments");
  const writableOwners = sharedOwners.flatMap((owner) =>
    resolveWritableSharedHostTargets(owner, workspaceDir, attachmentsRelativePath).map(
      (target) => ({
        owner,
        target,
      }),
    ),
  );
  if (writableOwners.length === 0) {
    return { workspaceDir };
  }
  const pinnedOwner = writableOwners.find(
    ({ owner }) => !owner.sandbox.backend?.createFsBridge && owner.sandbox.fsBridge,
  );
  if (!pinnedOwner?.owner.sandbox.fsBridge) {
    const ingressOwner = writableOwners[0]?.owner;
    if (!ingressOwner) {
      throw new Error("writable sandbox attachment owner was unavailable");
    }
    const prepared = await deps
      .getSandboxBackendManager(ingressOwner.sandbox.backendId)
      ?.prepareAttachmentIngress?.({
        backend: ingressOwner.sandbox.backend!,
        runtimeId: ingressOwner.sandbox.runtimeId,
        sessionKey: ingressOwner.sessionKey,
        workspaceDir,
        containerWorkspaceDir: ingressOwner.sandbox.containerWorkdir,
        config: params.config,
        agentId: ingressOwner.agentId,
      });
    if (!prepared) {
      throw new Error(
        "sandbox backend does not expose a confined attachment ingress for its writable workspace",
      );
    }
    if (!prepared.sandboxFsBridge) {
      if (!prepared.sandboxAttachmentsRootDir) {
        throw new Error("sandbox attachment ingress did not expose a visible receipt root");
      }
      const preparedWritableOwners = sharedOwners.flatMap((owner) =>
        resolveWritableSharedHostTargets(owner, prepared.workspaceDir, attachmentsRelativePath),
      );
      if (preparedWritableOwners.length > 0) {
        throw new Error("sandbox attachment ingress is writable through another sandbox boundary");
      }
      return {
        workspaceDir: prepared.workspaceDir,
        sandboxAttachmentsRootDir: prepared.sandboxAttachmentsRootDir,
      };
    }
    if (!prepared.sandboxAttachmentsRootDir) {
      throw new Error("sandbox attachment ingress did not expose a visible receipt root");
    }
    return await buildBridgeBoundary({
      owner: ingressOwner,
      workspaceDir: prepared.workspaceDir,
      sandboxFsBridge: prepared.sandboxFsBridge,
      sandboxAttachmentsRootDir: prepared.sandboxAttachmentsRootDir,
      workspaceMutationVisibility: prepared.workspaceMutationVisibility,
      config: params.config,
      fsCleanupLocator: prepared.cleanupLocator,
      cleanupContainerWorkspaceDir: prepared.cleanupContainerWorkspaceDir,
    });
  }
  return await buildBridgeBoundary({
    owner: pinnedOwner.owner,
    workspaceDir,
    sandboxFsBridge: pinnedOwner.owner.sandbox.fsBridge,
    sandboxAttachmentsRootDir: pinnedOwner.target.containerPath,
    workspaceMutationVisibility: "shared-host",
    config: params.config,
  });
}

export function sanitizeSubagentAttachmentMountPathHint(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed || hasPromptUnsafeControlCharacter(trimmed)) {
    return undefined;
  }
  return /^[A-Za-z0-9._\-/:]+$/.test(trimmed) ? trimmed : undefined;
}

function hasPromptUnsafeControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}
