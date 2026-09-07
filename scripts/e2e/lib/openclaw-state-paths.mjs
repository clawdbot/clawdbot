import path from "node:path";

export function resolveHomePath(value) {
  if (value === "~") {
    return process.env.HOME;
  }
  if (value?.startsWith("~/") || value?.startsWith("~\\")) {
    return path.join(process.env.HOME, value.slice(2));
  }
  return value;
}

export function resolveOpenClawStateDir() {
  return process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME, ".openclaw");
}

export function resolveOpenClawConfigPath() {
  return process.env.OPENCLAW_CONFIG_PATH || path.join(resolveOpenClawStateDir(), "openclaw.json");
}
