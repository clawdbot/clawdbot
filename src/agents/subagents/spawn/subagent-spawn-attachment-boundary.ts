import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/config.js";
import type { SandboxFsBridge } from "../../sandbox/fs-bridge.types.js";
import {
  buildSandboxFsMounts,
  resolveSandboxFsPathWithMounts,
  type SandboxResolvedFsPath,
} from "../../sandbox/fs-paths.js";
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

function resolveWritableSharedHostTarget(
  owner: ResolvedSandboxOwner,
  hostPath: string,
): SandboxResolvedFsPath | undefined {
  const sandbox = owner.sandbox;
  if (sandbox.backend?.capabilities?.workspaceMutationVisibility !== "shared-host") {
    return undefined;
  }
  try {
    const target = resolveSandboxFsPathWithMounts({
      filePath: hostPath,
      cwd: sandbox.workspaceDir,
      defaultWorkspaceRoot: sandbox.workspaceDir,
      defaultContainerRoot: sandbox.containerWorkdir,
      mounts: buildSandboxFsMounts(sandbox),
    });
    return target.writable ? target : undefined;
  } catch {
    return undefined;
  }
}

function resolveSandboxConfigLabel(sandbox: SandboxContext): string {
  const configLabel = sandbox.backend?.configLabel?.trim();
  if (!configLabel) {
    throw new Error("sandbox backend does not expose a durable runtime identity");
  }
  return configLabel;
}

function buildBridgeBoundary(params: {
  owner: ResolvedSandboxOwner;
  workspaceDir: string;
  sandboxFsBridge: SandboxFsBridge;
  sandboxAttachmentsRootDir: string;
  workspaceMutationVisibility: "shared-host" | "runtime-local";
}): SubagentAttachmentStagingBoundary {
  const { owner } = params;
  return {
    workspaceDir: params.workspaceDir,
    sandboxFsBridge: params.sandboxFsBridge,
    sandboxAttachmentsRootDir: params.sandboxAttachmentsRootDir,
    sandboxOwner: {
      sessionKey: owner.sessionKey,
      agentId: owner.agentId,
      workspaceDir: owner.workspaceDir,
      identity: {
        backendId: owner.sandbox.backendId,
        runtimeId: owner.sandbox.runtimeId,
        configLabel: resolveSandboxConfigLabel(owner.sandbox),
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
    return buildBridgeBoundary({
      owner: childOwner,
      workspaceDir,
      sandboxFsBridge,
      sandboxAttachmentsRootDir,
      workspaceMutationVisibility: "runtime-local",
    });
  }

  const sharedOwners = [childOwner];
  if (params.requesterSandboxed) {
    const requesterSandbox = await deps.resolveSandboxContext({
      config: params.config,
      agentId: params.requesterAgentId,
      sessionKey: params.requesterSessionKey,
      workspaceDir: params.requesterWorkspaceDir,
    });
    if (!requesterSandbox) {
      throw new Error("requester sandbox context was unavailable");
    }
    sharedOwners.push({
      sessionKey: params.requesterSessionKey,
      agentId: params.requesterAgentId,
      workspaceDir: requesterSandbox.workspaceDir,
      sandbox: requesterSandbox,
    });
  }

  const hostAttachmentsRoot = path.join(workspaceDir, ".openclaw", "attachments");
  const writableOwners = sharedOwners.flatMap((owner) => {
    const target = resolveWritableSharedHostTarget(owner, hostAttachmentsRoot);
    return target ? [{ owner, target }] : [];
  });
  if (writableOwners.length === 0) {
    return { workspaceDir };
  }
  const pinnedOwner = writableOwners.find(
    ({ owner }) => !owner.sandbox.backend?.createFsBridge && owner.sandbox.fsBridge,
  );
  if (!pinnedOwner?.owner.sandbox.fsBridge) {
    throw new Error(
      "sandbox attachments require a descriptor-relative ingress bridge for a writable shared workspace; use read-only workspace access or a runtime-local sandbox backend",
    );
  }
  return buildBridgeBoundary({
    owner: pinnedOwner.owner,
    workspaceDir,
    sandboxFsBridge: pinnedOwner.owner.sandbox.fsBridge,
    sandboxAttachmentsRootDir: pinnedOwner.target.containerPath,
    workspaceMutationVisibility: "shared-host",
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
