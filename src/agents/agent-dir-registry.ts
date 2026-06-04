import path from "node:path";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";

// Process-local registry mapping resolved agent directories back to agent ids.
// It lets later runtime paths recover scope from an already-prepared agent dir.
const agentIdByDir = new Map<string, string>();

function normalizeAgentDirKey(agentDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(resolveUserPath(agentDir, env));
}

/** Register a resolved agent directory for later reverse lookup. */
export function registerResolvedAgentDir(params: {
  agentId: string;
  agentDir: string;
  env?: NodeJS.ProcessEnv;
}): void {
  agentIdByDir.set(
    normalizeAgentDirKey(params.agentDir, params.env),
    normalizeAgentId(params.agentId),
  );
}

/** Resolve the agent id previously registered for an agent directory. */
export function resolveRegisteredAgentIdForDir(
  agentDir: string,
  env?: NodeJS.ProcessEnv,
): string | undefined {
  return agentIdByDir.get(normalizeAgentDirKey(agentDir, env));
}
