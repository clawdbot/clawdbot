import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/config.js";
import type { SandboxFsBridge } from "../../sandbox/fs-bridge.types.js";
import { getSubagentSpawnDeps } from "./subagent-spawn-deps.js";

export type SubagentAttachmentStagingBoundary = {
  workspaceDir?: string;
  sandboxFsBridge?: SandboxFsBridge;
  sandboxWorkspaceDir?: string;
  sandboxIdentity?: {
    backendId: string;
    runtimeId: string;
    configLabel: string;
  };
};

export async function resolveSubagentAttachmentStagingBoundary(params: {
  config: OpenClawConfig;
  targetAgentId: string;
  childSessionKey: string;
  workspaceDir?: string;
}): Promise<SubagentAttachmentStagingBoundary> {
  const deps = getSubagentSpawnDeps();
  const sandbox = await deps.resolveSandboxContext({
    config: params.config,
    agentId: params.targetAgentId,
    sessionKey: params.childSessionKey,
    workspaceDir: params.workspaceDir,
  });
  if (!sandbox) {
    throw new Error("child sandbox context was unavailable");
  }
  const workspaceDir = sandbox.workspaceDir ?? params.workspaceDir;
  if (sandbox.backend?.capabilities?.workspaceMutationVisibility === "shared-host") {
    return { workspaceDir };
  }
  const configLabel = sandbox.backend?.configLabel?.trim();
  if (!configLabel) {
    throw new Error("child sandbox backend does not expose a durable runtime identity");
  }
  return {
    workspaceDir,
    sandboxFsBridge: deps.createSandboxWorkspaceIngressFsBridge(sandbox),
    sandboxWorkspaceDir: sandbox.agentWorkspaceDir ?? workspaceDir,
    sandboxIdentity: {
      backendId: sandbox.backendId,
      runtimeId: sandbox.runtimeId,
      configLabel,
    },
  };
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
