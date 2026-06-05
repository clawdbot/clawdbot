// Reads local agent/session state for status output.
// This never contacts the gateway; it inspects configured agents and their read-only session stores.

import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { readSessionStoreReadOnly } from "../config/sessions/store-read.js";
import type { OpenClawConfig } from "../config/types.js";
import { listGatewayAgentsBasic } from "../gateway/agent-list.js";
import { pathExists } from "../infra/fs-safe.js";

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
  defaultId: string;
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

  const statuses: AgentLocalStatus[] = [];
  for (const agent of agentList.agents) {
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

    const sessionsPath = resolveStorePath(cfg.session?.store, { agentId });
    const store = readSessionStoreReadOnly(sessionsPath);
    const sessions = Object.entries(store)
      // Global/unknown buckets are aggregate compatibility entries, not agent activity.
      .filter(([key]) => key !== "global" && key !== "unknown")
      .map(([, entry]) => entry);
    const sessionsCount = sessions.length;
    const lastUpdatedAt = sessions.reduce((max, e) => Math.max(max, e?.updatedAt ?? 0), 0);
    const resolvedLastUpdatedAt = lastUpdatedAt > 0 ? lastUpdatedAt : null;
    const lastActiveAgeMs = resolvedLastUpdatedAt ? now - resolvedLastUpdatedAt : null;

    statuses.push({
      id: agentId,
      name: agent.name,
      workspaceDir,
      bootstrapPending,
      sessionsPath,
      sessionsCount,
      lastUpdatedAt: resolvedLastUpdatedAt,
      lastActiveAgeMs,
    });
  }

  const totalSessions = statuses.reduce((sum, s) => sum + s.sessionsCount, 0);
  const bootstrapPendingCount = statuses.reduce((sum, s) => sum + (s.bootstrapPending ? 1 : 0), 0);
  return {
    defaultId: agentList.defaultId,
    agents: statuses,
    totalSessions,
    bootstrapPendingCount,
  };
}
