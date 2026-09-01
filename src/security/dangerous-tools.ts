// Shared tool-risk constants.
// Keep these centralized so gateway HTTP restrictions and security audits don't drift.
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";

/**
 * Tools denied via Gateway HTTP `POST /tools/invoke` by default.
 * These are high-risk because they enable session orchestration, control-plane actions,
 * or interactive flows that don't make sense over a non-interactive HTTP surface.
 */
export const DEFAULT_GATEWAY_HTTP_TOOL_DENY = [
  // Direct command execution — immediate RCE surface
  "exec",
  // Arbitrary child process creation — immediate RCE surface
  "spawn",
  // Shell command execution — immediate RCE surface
  "shell",
  // Arbitrary file mutation on the host
  "fs_write",
  // Arbitrary file deletion on the host
  "fs_delete",
  // Arbitrary file move/rename on the host
  "fs_move",
  // Patch application can rewrite arbitrary files
  "apply_patch",
  // Shared terminal input can execute commands and scrollback can expose host secrets.
  "terminal",
  // Local HTTP exposure can publish arbitrary workspace applications.
  "portal",
  // Session orchestration — spawning agents remotely is RCE
  "sessions_spawn",
  // Cross-session injection — message injection across sessions
  "sessions_send",
  // External conversation discovery and delivery use server-held channel credentials
  "conversations_list",
  "conversations_send",
  "conversations_turn",
  // Persistent automation control plane — can create/update/remove scheduled runs
  AUTOMATIONS_TOOL_NAME,
  // Gateway config can expose secrets and host topology
  "gateway",
  // Node command relay can reach system.run on paired hosts
  "nodes",
  // Desktop control on a paired Mac (pointer/keyboard) and screen reads
  "computer",
  // Android AccessibilityService reads and cross-app UI control
  "mobile_ui",
  "openclaw",
] as const;

/**
 * Sensitive control-plane tools. `automations` can persist scheduled runs; `gateway`
 * exposes configuration and schema details even though its agent actions are read-only.
 */
export const GATEWAY_CONTROL_PLANE_TOOLS = [AUTOMATIONS_TOOL_NAME, "gateway"] as const;

/**
 * Core tools that require sender owner identity on Gateway-scoped surfaces.
 * `gateway.tools.allow` can remove the default HTTP deny only for owner/trusted-operator
 * callers; non-owner identity-bearing callers must not receive server-credential wrappers.
 */
export const GATEWAY_OWNER_ONLY_CORE_TOOLS = [
  ...GATEWAY_CONTROL_PLANE_TOOLS,
  "sessions",
  "screen",
  "terminal",
  "portal",
  "conversations_list",
  "conversations_send",
  "conversations_turn",
  "nodes",
  "computer",
  "mobile_ui",
  "openclaw",
] as const;
