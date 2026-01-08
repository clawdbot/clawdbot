import os from "node:os";
import path from "node:path";

import type { ClawdbotConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "./workspace.js";

export function resolveAgentIdFromSessionKey(
  sessionKey?: string | null,
): string {
  const parsed = parseAgentSessionKey(sessionKey);
  return normalizeAgentId(parsed?.agentId ?? DEFAULT_AGENT_ID);
}

export function resolveAgentConfig(
  cfg: ClawdbotConfig,
  agentId: string,
):
  | {
      name?: string;
      workspace?: string;
      agentDir?: string;
      model?: string;
      subagents?: {
        allowAgents?: string[];
      };
      sandbox?: {
        mode?: "off" | "non-main" | "all";
        workspaceAccess?: "none" | "ro" | "rw";
        scope?: "session" | "agent" | "shared";
        perSession?: boolean;
        workspaceRoot?: string;
        tools?: {
          allow?: string[];
          deny?: string[];
        };
      };
      tools?: {
        allow?: string[];
        deny?: string[];
      };
    }
  | undefined {
  const id = normalizeAgentId(agentId);
  const agents = cfg.routing?.agents;
  if (!agents || typeof agents !== "object") return undefined;
  const entry = agents[id];
  if (!entry || typeof entry !== "object") return undefined;
  return {
    name: typeof entry.name === "string" ? entry.name : undefined,
    workspace:
      typeof entry.workspace === "string" ? entry.workspace : undefined,
    agentDir: typeof entry.agentDir === "string" ? entry.agentDir : undefined,
    model: typeof entry.model === "string" ? entry.model : undefined,
    subagents:
      typeof entry.subagents === "object" && entry.subagents
        ? entry.subagents
        : undefined,
    sandbox: entry.sandbox,
    tools: entry.tools,
  };
}

export function resolveAgentWorkspaceDir(cfg: ClawdbotConfig, agentId: string) {
  const id = normalizeAgentId(agentId);
  const configured = resolveAgentConfig(cfg, id)?.workspace?.trim();
  if (configured) return resolveUserPath(configured);
  if (id === DEFAULT_AGENT_ID) {
    const legacy = cfg.agent?.workspace?.trim();
    if (legacy) return resolveUserPath(legacy);
    return DEFAULT_AGENT_WORKSPACE_DIR;
  }
  return path.join(os.homedir(), `clawd-${id}`);
}

export function resolveAgentDir(cfg: ClawdbotConfig, agentId: string) {
  const id = normalizeAgentId(agentId);
  const configured = resolveAgentConfig(cfg, id)?.agentDir?.trim();
  if (configured) return resolveUserPath(configured);
  const root = resolveStateDir(process.env, os.homedir);
  return path.join(root, "agents", id, "agent");
}

/**
 * Resolve the agent directory for the default agent without requiring config.
 * Used by onboarding when writing auth profiles before config is fully set up.
 */
export function resolveDefaultAgentDir(): string {
  const root = resolveStateDir(process.env, os.homedir);
  return path.join(root, "agents", DEFAULT_AGENT_ID, "agent");
}
