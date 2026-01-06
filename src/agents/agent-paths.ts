import path from "node:path";

import { resolveConfigDir, resolveUserPath } from "../utils.js";

export function resolveClawdbotAgentDir(): string {
  const defaultAgentDir = path.join(resolveConfigDir(), "agent");
  const override =
    process.env.CLAWDBOT_AGENT_DIR?.trim() ||
    process.env.PI_CODING_AGENT_DIR?.trim() ||
    defaultAgentDir;
  return resolveUserPath(override);
}

export function ensureClawdbotAgentEnv(): string {
  const dir = resolveClawdbotAgentDir();
  if (!process.env.CLAWDBOT_AGENT_DIR) process.env.CLAWDBOT_AGENT_DIR = dir;
  if (!process.env.PI_CODING_AGENT_DIR) process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}
