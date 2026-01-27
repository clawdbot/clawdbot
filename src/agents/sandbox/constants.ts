import os from "node:os";
import path from "node:path";

import { CHANNEL_IDS } from "../../channels/registry.js";
import { STATE_DIR } from "../../config/config.js";

export const DEFAULT_SANDBOX_WORKSPACE_ROOT = path.join(os.homedir(), ".clawdbot", "sandboxes");

export const DEFAULT_SANDBOX_IMAGE = "moltbot-sandbox:bookworm-slim";
export const DEFAULT_SANDBOX_CONTAINER_PREFIX = "moltbot-sbx-";
export const DEFAULT_SANDBOX_WORKDIR = "/workspace";
export const DEFAULT_SANDBOX_IDLE_HOURS = 24;
export const DEFAULT_SANDBOX_MAX_AGE_DAYS = 7;

export const DEFAULT_TOOL_ALLOW = [
  "exec",
  "process",
  "read",
  "write",
  "edit",
  "apply_patch",
  "image",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "session_status",
] as const;

// Provider docking: keep sandbox policy aligned with provider tool names.
export const DEFAULT_TOOL_DENY = [
  "browser",
  "canvas",
  "nodes",
  "cron",
  "gateway",
  ...CHANNEL_IDS,
] as const;

export const DEFAULT_SANDBOX_BROWSER_IMAGE = "moltbot-sandbox-browser:bookworm-slim";
export const DEFAULT_SANDBOX_COMMON_IMAGE = "moltbot-sandbox-common:bookworm-slim";

export const DEFAULT_SANDBOX_BROWSER_PREFIX = "moltbot-sbx-browser-";
export const DEFAULT_SANDBOX_BROWSER_CDP_PORT = 9222;
export const DEFAULT_SANDBOX_BROWSER_VNC_PORT = 5900;
export const DEFAULT_SANDBOX_BROWSER_NOVNC_PORT = 6080;
export const DEFAULT_SANDBOX_BROWSER_AUTOSTART_TIMEOUT_MS = 12_000;

export const SANDBOX_AGENT_WORKSPACE_MOUNT = "/agent";

const resolvedSandboxStateDir = STATE_DIR ?? path.join(os.homedir(), ".clawdbot");
export const SANDBOX_STATE_DIR = path.join(resolvedSandboxStateDir, "sandbox");
export const SANDBOX_REGISTRY_PATH = path.join(SANDBOX_STATE_DIR, "containers.json");
export const SANDBOX_BROWSER_REGISTRY_PATH = path.join(SANDBOX_STATE_DIR, "browsers.json");
