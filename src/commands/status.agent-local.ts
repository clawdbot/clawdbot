// Reads local agent/session state for status output.
// This never contacts the gateway; it inspects configured agents and their read-only session stores.

import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.js";
import { listGatewayAgentsBasic, type GatewayAgentOwnership } from "../gateway/agent-list.js";
import { pathExists } from "../infra/fs-safe.js";
import { readStatusSessionStores } from "../status/session-stores.js";

export type AgentLocalStatus = {
  id: string;
  name?: string;
  workspaceDir: string | null;
  bootstrapPending: boolean | null;
  sessionsPath: string;
  sessionsCount: number;
  lastUpdatedAt: number | null;
  lastActiveAgeMs: number | null;
};

type AgentLocalStatusesResult = {
  defaultId: string | null;
  ownership: GatewayAgentOwnership;
  selectionRequired: boolean;
  agents: AgentLocalStatus[];
  totalSessions: number;
  bootstrapPendingCount: number;
};

/** Returns per-agent local workspace, bootstrap, session count, and last activity status. */
export async function getAgentLocalStatuses(
  cfg: OpenClawConfig,
): Promise<AgentLocalStatusesResult> {
  const agentList = listGatewayAgentsBasic(cfg);
  const now = Date.now();

  const sessionStores = readStatusSessionStores(cfg, agentList.agents);
  const statuses: AgentLocalStatus[] = [];
  for (const { agent, path: sessionsPath, sessions } of sessionStores.byAgent) {
    const agentId = agent.id;
    const workspaceDir = (() => {
      try {
        return resolveAgentWorkspaceDir(cfg, agentId);
      } catch {
        // A malformed workspace setting should not prevent status from showing other agents.
        return null;
      }
    })();

    const bootstrapPath = workspaceDir != null ? path.join(workspaceDir, "BOOTSTRAP.md") : null;
    const bootstrapPending = bootstrapPath != null ? await pathExists(bootstrapPath) : null;

    const lastUpdatedAt = sessions.reduce(
      (max, session) => Math.max(max, session.entry.updatedAt ?? 0),
      0,
    );
    const resolvedLastUpdatedAt = lastUpdatedAt > 0 ? lastUpdatedAt : null;
    const lastActiveAgeMs = resolvedLastUpdatedAt ? now - resolvedLastUpdatedAt : null;

    statuses.push({
      id: agentId,
      name: agent.name,
      workspaceDir,
      bootstrapPending,
      sessionsPath,
      sessionsCount: sessions.length,
      lastUpdatedAt: resolvedLastUpdatedAt,
      lastActiveAgeMs,
    });
  }

  const bootstrapPendingCount = statuses.reduce((sum, s) => sum + (s.bootstrapPending ? 1 : 0), 0);
  return {
    // The gateway keeps a projected first id for wire compatibility. Local status must
    // preserve the selection state so read-only consumers never treat that id as an owner.
    defaultId: agentList.selectionRequired ? null : agentList.defaultId,
    ownership: agentList.ownership ?? (agentList.selectionRequired === true ? "explicit" : "sole"),
    selectionRequired: agentList.selectionRequired === true,
    agents: statuses,
    totalSessions: sessionStores.sessions.length,
    bootstrapPendingCount,
  };
}
