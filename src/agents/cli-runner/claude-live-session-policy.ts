import type { ExecAsk, ExecSecurity } from "../../infra/exec-approvals.js";
import type { PreparedCliRunContext } from "./types.js";

export const LIVE_SESSION_LIMITS = {
  maxSessions: 16,
  maxStderrChars: 64 * 1024,
} as const;

/** Returns whether a prepared backend context is eligible for Claude live stdio reuse. */
export function acceptsClaudeLive(context: PreparedCliRunContext): boolean {
  return (
    context.params.sessionEntry?.execHost !== "node" &&
    context.backendResolved.id === "claude-cli" &&
    context.preparedBackend.backend.liveSession === "claude-stdio" &&
    context.preparedBackend.backend.output === "jsonl" &&
    context.preparedBackend.backend.input === "stdin"
  );
}

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
