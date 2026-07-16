import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";

const WORKTREE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isWorktreeNameValid(value: string): boolean {
  const name = value.trim();
  return !name || WORKTREE_NAME_PATTERN.test(name);
}

/** Maps the new-session draft selections onto additive sessions.create params. */
export function buildDraftSessionCreateParams(draft: {
  key?: string;
  agentId: string;
  message: string;
  model?: string;
  thinkingLevel?: string;
  attachments?: unknown[];
  worktree: boolean;
  baseRef?: string;
  worktreeName?: string;
  cwd?: string;
  workspace?: string;
  execNode?: string;
  catalogId?: string;
}): Record<string, unknown> {
  const cwd = normalizeOptionalString(draft.cwd);
  const workspace = normalizeOptionalString(draft.workspace);
  const execNode = normalizeOptionalString(draft.execNode);
  const catalogId = normalizeOptionalString(draft.catalogId);
  const model = normalizeOptionalString(draft.model);
  const thinkingLevel = normalizeOptionalString(draft.thinkingLevel);
  const customFolder = cwd && cwd !== workspace ? cwd : undefined;
  return {
    ...(normalizeOptionalString(draft.key) ? { key: normalizeOptionalString(draft.key) } : {}),
    agentId: normalizeAgentId(draft.agentId),
    message: draft.message,
    ...(draft.attachments?.length ? { attachments: draft.attachments } : {}),
    ...(catalogId ? { catalogId } : {}),
    ...(!catalogId && model ? { model } : {}),
    ...(!catalogId && thinkingLevel ? { thinkingLevel } : {}),
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
          ...(customFolder && !execNode ? { cwd: customFolder } : {}),
        }
      : {}),
    ...(execNode ? { execNode, ...(cwd ? { cwd } : {}) } : {}),
  };
}
