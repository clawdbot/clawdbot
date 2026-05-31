import path from "node:path";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveOpenClawStateSqliteDir } from "./openclaw-state-db.paths.js";

export type OpenClawAgentSqlitePathOptions = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
};

export function resolveOpenClawAgentSqlitePath(options: OpenClawAgentSqlitePathOptions): string {
  const agentId = normalizeAgentId(options.agentId);
  return (
    options.path ??
    path.join(
      path.dirname(resolveOpenClawStateSqliteDir(options.env ?? process.env)),
      "agents",
      agentId,
      "agent",
      "openclaw-agent.sqlite",
    )
  );
}

export function resolveOpenClawAgentSqliteDir(options: OpenClawAgentSqlitePathOptions): string {
  return path.dirname(resolveOpenClawAgentSqlitePath(options));
}
