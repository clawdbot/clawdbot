import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";

/** Maps the new-session draft selections onto additive sessions.create params. */
export function buildDraftSessionCreateParams(draft: {
  agentId: string;
  message: string;
  worktree: boolean;
  baseRef?: string;
  worktreeName?: string;
  cwd?: string;
  workspace?: string;
  execNode?: string;
}): Record<string, unknown> {
  const cwd = normalizeOptionalString(draft.cwd);
  const workspace = normalizeOptionalString(draft.workspace);
  const customFolder = cwd && cwd !== workspace ? cwd : undefined;
  return {
    agentId: normalizeAgentId(draft.agentId),
    message: draft.message,
    ...(draft.worktree
      ? {
          worktree: true,
          // Passing the base explicitly also skips the create-time origin fetch.
          ...(normalizeOptionalString(draft.baseRef)
            ? { worktreeBaseRef: normalizeOptionalString(draft.baseRef) }
            : {}),
          ...(normalizeOptionalString(draft.worktreeName)
            ? { worktreeName: normalizeOptionalString(draft.worktreeName) }
            : {}),
          ...(customFolder ? { cwd: customFolder } : {}),
        }
      : {}),
    ...(normalizeOptionalString(draft.execNode)
      ? { execNode: normalizeOptionalString(draft.execNode) }
      : {}),
  };
}
