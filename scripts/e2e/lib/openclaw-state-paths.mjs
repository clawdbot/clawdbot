import path from "node:path";

export function resolveOpenClawStateDir() {
  return process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME, ".openclaw");
}

export function resolveOpenClawConfigPath() {
  return process.env.OPENCLAW_CONFIG_PATH || path.join(resolveOpenClawStateDir(), "openclaw.json");
}
