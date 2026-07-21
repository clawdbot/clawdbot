// Doctor repair for legacy installs that relied on the implicit main agent.
import fs from "node:fs";
import path from "node:path";
import { resolveDefaultAgentWorkspaceDir } from "../../../agents/workspace-default.js";
import { resolveStateDir } from "../../../config/paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveUserPath } from "../../../utils.js";

const LEGACY_IMPLICIT_AGENT_ID = "main";
const LEGACY_WORKSPACE_MARKERS = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "MEMORY.md",
] as const;

function directoryHasEntries(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function hasLegacyImplicitMainState(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  const stateDir = resolveStateDir(env);
  const stateDirs = [
    path.join(stateDir, "agents", LEGACY_IMPLICIT_AGENT_ID, "agent"),
    path.join(stateDir, "agents", LEGACY_IMPLICIT_AGENT_ID, "sessions"),
    path.join(stateDir, "sessions"),
  ];
  if (stateDirs.some(directoryHasEntries)) {
    return true;
  }
  const configuredWorkspace = cfg.agents?.defaults?.workspace?.trim();
  const workspace = configuredWorkspace
    ? resolveUserPath(configuredWorkspace, env)
    : resolveDefaultAgentWorkspaceDir(env);
  return LEGACY_WORKSPACE_MARKERS.some((name) => fs.existsSync(path.join(workspace, name)));
}

export function maybeRepairAgentRoster(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): { config: OpenClawConfig; changes: string[] } {
  const list = cfg.agents?.list ?? [];
  if (list.length > 0 || !hasLegacyImplicitMainState(cfg, env)) {
    return { config: cfg, changes: [] };
  }
  return {
    config: {
      ...cfg,
      agents: {
        ...cfg.agents,
        list: [{ id: LEGACY_IMPLICIT_AGENT_ID, default: true }],
      },
    },
    changes: [
      'Added agents.list entry { id: "main", default: true } for legacy main-agent workspace or session state.',
    ],
  };
}
