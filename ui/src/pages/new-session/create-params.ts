import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";

const WORKTREE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * One closed visibility mode instead of independent incognito/draft booleans:
 * an incognito session is never persisted, so "incognito draft" is unrepresentable.
 */
export type NewSessionVisibility = "normal" | "draft" | "incognito";

export function canStartSessionAsDraft(params: {
  allowedVisibilities?: readonly string[];
  hasMultipleIdentities?: boolean;
}): boolean {
  return (
    params.allowedVisibilities?.includes("draft") === true && params.hasMultipleIdentities === true
  );
}

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
  contextWindow?: string;
  thinkingLevel?: string;
  visibility?: NewSessionVisibility;
  attachments?: unknown[];
  projectId?: string;
  worktree: boolean;
  baseRef?: string;
  worktreeName?: string;
  cwd?: string;
  workspace?: string;
  catalogId?: string;
  category?: string;
}): Record<string, unknown> {
  const cwd = normalizeOptionalString(draft.cwd);
  const workspace = normalizeOptionalString(draft.workspace);
  const catalogId = normalizeOptionalString(draft.catalogId);
  const category = normalizeOptionalString(draft.category);
  const model = normalizeOptionalString(draft.model);
  const contextWindow = normalizeOptionalString(draft.contextWindow);
  const thinkingLevel = normalizeOptionalString(draft.thinkingLevel);
  const projectId = normalizeOptionalString(draft.projectId);
  const customFolder = !projectId && cwd && cwd !== workspace ? cwd : undefined;
  return {
    ...(normalizeOptionalString(draft.key) ? { key: normalizeOptionalString(draft.key) } : {}),
    agentId: normalizeAgentId(draft.agentId),
    message: draft.message,
    ...(draft.visibility === "incognito" ? { incognito: true } : {}),
    ...(draft.visibility === "draft" ? { visibility: "draft" } : {}),
    ...(draft.attachments?.length ? { attachments: draft.attachments } : {}),
    ...(catalogId ? { catalogId } : {}),
    ...(category ? { category } : {}),
    ...(!catalogId && model ? { model } : {}),
    ...(!catalogId && contextWindow ? { contextWindow } : {}),
    ...(!catalogId && thinkingLevel ? { thinkingLevel } : {}),
    ...(projectId ? { projectId } : {}),
    ...(customFolder ? { cwd: customFolder } : {}),
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
        }
      : {}),
  };
}
