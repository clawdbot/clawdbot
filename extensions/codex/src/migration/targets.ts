import path from "node:path";
import {
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "openclaw/plugin-sdk/agent-runtime";
import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveHomePath } from "./helpers.js";

type CodexMigrationTargets = {
  workspaceDir: string;
  agentDir: string;
};

export function resolveCodexMigrationTargets(ctx: MigrationProviderContext): CodexMigrationTargets {
  const cfg = ctx.config;
  const agentId = resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const configuredAgentDir = resolveAgentConfig(cfg, agentId)?.agentDir?.trim();
  const agentDir =
    ctx.runtime?.agent?.resolveAgentDir(cfg, agentId) ??
    (configuredAgentDir ? resolveHomePath(configuredAgentDir) : undefined) ??
    path.join(ctx.stateDir, "agents", agentId, "agent");
  return { workspaceDir, agentDir };
}
