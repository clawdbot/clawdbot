import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { LEGACY_IMPLICIT_AGENT_ID } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";

/** Resolve the shipped shared-main auth store, including its supported relocation. */
export function resolveSharedMainAuthAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCLAW_AGENT_DIR?.trim();
  return configured
    ? resolveUserPath(configured, env)
    : path.join(resolveStateDir(env), "agents", LEGACY_IMPLICIT_AGENT_ID, "agent");
}
