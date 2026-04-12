import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/**
 * Default max parent token count beyond which thread/session parent forking is skipped.
 * This prevents new thread sessions from inheriting near-full parent context.
 * See #26905.
 */
const DEFAULT_PARENT_FORK_MAX_TOKENS = 100_000;

export function resolveParentForkMaxTokens(cfg: OpenClawConfig): number {
  const configured = cfg.session?.parentForkMaxTokens;
  if (typeof configured === "number" && Number.isFinite(configured) && configured >= 0) {
    return Math.floor(configured);
  }
  return DEFAULT_PARENT_FORK_MAX_TOKENS;
}

export async function forkSessionFromParent(params: {
  parentEntry: SessionEntry;
  agentId: string;
  sessionsDir: string;
}): Promise<{ sessionId: string; sessionFile: string } | null> {
  const runtime = await import("./session-fork.runtime.js");
  return runtime.forkSessionFromParentRuntime(params);
}
