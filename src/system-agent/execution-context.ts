import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import { SYSTEM_AGENT_ID } from "./agent-id.js";

/** Bound probes and actual turns must select the same native startup and sandbox context. */
export async function prepareSystemAgentExecutionContext() {
  const workspaceDir = path.join(resolveStateDir(), "openclaw", "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  return {
    workspaceDir,
    agentId: SYSTEM_AGENT_ID,
    policySessionKey: buildAgentMainSessionKey({ agentId: SYSTEM_AGENT_ID }),
  };
}
