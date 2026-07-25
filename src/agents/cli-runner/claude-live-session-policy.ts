import type { ExecAsk, ExecSecurity } from "../../infra/exec-approvals.js";

export const LIVE_SESSION_LIMITS = {
  maxSessions: 16,
  maxStderrChars: 64 * 1024,
} as const;

/** Resolve Claude's live permission mode without asking root to use an unsupported bypass. */
export function resolveClaudeLiveMode(
  security: ExecSecurity,
  ask: ExecAsk,
  uid?: number,
): "bypassPermissions" | "default" {
  // Claude Code rejects bypassPermissions before stdio control requests when
  // running as root. Default mode still lets OpenClaw answer those requests
  // from the authoritative exec policy in handleClaudeLiveControlRequest.
  return security === "full" && ask === "off" && uid !== 0 ? "bypassPermissions" : "default";
}
