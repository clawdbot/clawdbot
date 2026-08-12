import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveSandboxAttachmentIngressWorkspace } from "../../sandbox/attachment-ingress.js";
import type { SandboxFsBridge } from "../../sandbox/fs-bridge.types.js";
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
      fsCleanupLocator: unknown;
    };
  };
};

type ResolvedSandboxOwner = {
  sessionKey: string;
  agentId: string;
  workspaceDir: string;
  sandbox: SandboxContext;
};

async function buildBridgeBoundary(params: {
  owner: ResolvedSandboxOwner;
  workspaceDir: string;
  sandboxAttachmentsRootDir: string;
  config: OpenClawConfig;
  fsCleanupLocator?: unknown;
  cleanupContainerWorkspaceDir?: string;
}): Promise<SubagentAttachmentStagingBoundary> {
  const { owner } = params;
  const manager = getSubagentSpawnDeps().getSandboxBackendManager(owner.sandbox.backendId);
  const fsCleanupLocator =
    params.fsCleanupLocator ??
    (await manager?.prepareFsCleanupLocator?.({
      backend: owner.sandbox.backend!,
      runtimeId: owner.sandbox.runtimeId,
      containerWorkspaceDir: params.cleanupContainerWorkspaceDir ?? owner.sandbox.containerWorkdir,
      config: params.config,
      agentId: owner.agentId,
    }));
  if (fsCleanupLocator === undefined || !manager?.createFsCleanupBridge) {
    throw new Error("sandbox backend does not expose durable filesystem cleanup");
  }
  const cleanupBridge = await manager.createFsCleanupBridge({
    runtimeId: owner.sandbox.runtimeId,
    workspaceDir: owner.workspaceDir,
    containerWorkspaceDir: params.cleanupContainerWorkspaceDir ?? owner.sandbox.containerWorkdir,
    locator: fsCleanupLocator,
    config: params.config,
    agentId: owner.agentId,
  });
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
        fsCleanupLocator,
      },
    },
  };
}

export async function resolveSubagentAttachmentStagingBoundary(params: {
  config: OpenClawConfig;
  targetAgentId: string;
  childSessionKey: string;
  childSandboxed: boolean;
  workspaceDir?: string;
}): Promise<SubagentAttachmentStagingBoundary> {
  const privateIngressWorkspace = resolveSandboxAttachmentIngressWorkspace(params.childSessionKey);
  if (!params.childSandboxed) {
    return {
      workspaceDir: privateIngressWorkspace,
      sandboxAttachmentsRootDir: path.join(privateIngressWorkspace, ".openclaw", "attachments"),
    };
  }
  const deps = getSubagentSpawnDeps();
  const childSandbox = await deps.resolveSandboxContext({
    config: params.config,
    agentId: params.targetAgentId,
    sessionKey: params.childSessionKey,
    // Attachment bytes are model inputs. Give this child a distinct runtime
    // even when the operator's normal sandbox lifetime is agent/shared.
    sessionIsolation: true,
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
      sandboxAttachmentsRootDir,
      config: params.config,
    });
  }

  const prepared = await deps
    .getSandboxBackendManager(childOwner.sandbox.backendId)
    ?.prepareAttachmentIngress?.({
      backend: childOwner.sandbox.backend!,
      runtimeId: childOwner.sandbox.runtimeId,
      sessionKey: childOwner.sessionKey,
      workspaceDir,
      containerWorkspaceDir: childOwner.sandbox.containerWorkdir,
      config: params.config,
      agentId: childOwner.agentId,
      hostIngressWorkspaceDir: privateIngressWorkspace,
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
    const expectedRoot = path.join(privateIngressWorkspace, ".openclaw", "attachments");
    if (
      path.resolve(prepared.workspaceDir) !== path.resolve(privateIngressWorkspace) ||
      path.resolve(prepared.sandboxAttachmentsRootDir) !== path.resolve(expectedRoot)
    ) {
      throw new Error("sandbox attachment ingress escaped the host-private attachment root");
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
    owner: childOwner,
    workspaceDir: prepared.workspaceDir,
    sandboxAttachmentsRootDir: prepared.sandboxAttachmentsRootDir,
    config: params.config,
    fsCleanupLocator: prepared.cleanupLocator,
    cleanupContainerWorkspaceDir: prepared.cleanupContainerWorkspaceDir,
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
