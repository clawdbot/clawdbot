/** Detects shared sandbox configurations that cannot share one workspace mount layout. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agent-scope.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { resolveSandboxHostPathViaExistingAncestor } from "./host-paths.js";
import { resolveSandboxWorkspaceLayoutPaths } from "./shared.js";

/** Returns an actionable reason when configured agents cannot share one runtime mount layout. */
export function resolveSharedSandboxWorkspaceConflictReason(params: {
  config?: OpenClawConfig;
  backendId: string;
  activeAgentId?: string;
  activeWorkspaceDir?: string;
}): string | undefined {
  if (!params.config) {
    return undefined;
  }
  const agentIds = new Set(listAgentIds(params.config));
  if (params.activeAgentId) {
    agentIds.add(params.activeAgentId);
  }
  const participants = [...agentIds].flatMap((agentId) => {
    const cfg = resolveSandboxConfigForAgent(params.config!, agentId);
    if (cfg.mode === "off" || cfg.scope !== "shared" || cfg.backend !== params.backendId) {
      return [];
    }
    const layout = resolveSandboxWorkspaceLayoutPaths({
      cfg,
      rawSessionKey: `agent:${agentId}:main`,
      agentId,
      workspaceDir:
        agentId === params.activeAgentId && params.activeWorkspaceDir
          ? params.activeWorkspaceDir
          : resolveAgentWorkspaceDir(params.config!, agentId),
    });
    const workspaceDir = resolveSandboxHostPathViaExistingAncestor(layout.workspaceDir);
    const agentWorkspaceDir = resolveSandboxHostPathViaExistingAncestor(layout.agentWorkspaceDir);
    const mounts =
      cfg.workspaceAccess === "ro"
        ? [`${workspaceDir} -> ${cfg.docker.workdir}`, `${agentWorkspaceDir} -> /agent`]
        : [`${workspaceDir} -> ${cfg.docker.workdir}`];
    return [
      {
        description: `${agentId} (${cfg.workspaceAccess}: ${mounts.join(", ")})`,
        identity: JSON.stringify([cfg.workspaceAccess, mounts]),
      },
    ];
  });
  if (new Set(participants.map((entry) => entry.identity)).size <= 1) {
    return undefined;
  }
  return [
    `Configured agents require incompatible mounts for one shared ${params.backendId} sandbox:`,
    ...participants.map((entry) => `- ${entry.description}`),
    'Set sandbox.scope to "agent" or "session", use workspaceAccess "none" with one shared workspaceRoot, or configure identical workspace mounts for every participating agent.',
    "After saving valid agents.* config, the Gateway hot-reloads it by default; retry the original action without restarting.",
  ].join("\n");
}

export function assertSharedSandboxRuntimeRemovalAllowed(params: {
  config: OpenClawConfig;
  containerName: string;
  sessionKey: string;
  backendId: string;
}): void {
  const reason =
    params.sessionKey === "shared"
      ? resolveSharedSandboxWorkspaceConflictReason(params)
      : undefined;
  if (reason) {
    throw new Error(
      `Refusing to remove grandfathered shared sandbox runtime ${params.containerName} until its workspace configuration is compatible; otherwise the runtime could not be recreated.\n${reason}`,
    );
  }
}
