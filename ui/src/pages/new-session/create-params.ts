import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import type { SessionCreateParams } from "../../lib/sessions/create.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";

const WORKTREE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * One closed visibility mode instead of independent incognito/draft booleans:
 * an incognito session is never persisted, so "incognito draft" is unrepresentable.
 */
export type NewSessionVisibility = "normal" | "draft" | "incognito";
export type DraftSessionCreateOverrides = Partial<
  Pick<SessionCreateParams, "message" | "attachments" | "displayName">
> & { mentions?: readonly HumanMention[]; visibility?: NewSessionVisibility };
export type DraftSessionCreateSelection = Partial<
  Pick<
    SessionCreateParams,
    "attachments" | "permissionMode" | "catalogId" | "category" | "displayName"
  >
> & {
  message: string;
  mentions?: readonly HumanMention[];
  visibility: NewSessionVisibility;
  toolOverrides?: SessionCreateParams["toolOverrides"] | null;
};

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
  mentions?: readonly HumanMention[];
  displayName?: string;
  model?: string;
  contextWindow?: string;
  thinkingLevel?: string;
  fastMode?: SessionCreateParams["fastMode"];
  toolOverrides?: SessionCreateParams["toolOverrides"] | null;
  permissionMode?: SessionCreateParams["permissionMode"];
  visibility?: NewSessionVisibility;
  attachments?: SessionCreateParams["attachments"];
  projectId?: string;
  projectGitUrl?: string;
  worktree: boolean;
  baseRef?: string;
  worktreeName?: string;
  cwd?: string;
  workspace?: string;
  catalogId?: string;
  category?: string;
}): SessionCreateParams {
  const cwd = normalizeOptionalString(draft.cwd);
  const workspace = normalizeOptionalString(draft.workspace);
  const catalogId = normalizeOptionalString(draft.catalogId);
  const category = normalizeOptionalString(draft.category);
  const model = normalizeOptionalString(draft.model);
  const contextWindow = normalizeOptionalString(draft.contextWindow);
  const thinkingLevel = normalizeOptionalString(draft.thinkingLevel);
  const projectId = normalizeOptionalString(draft.projectId);
  const projectGitUrl =
    !projectId && (draft.message.trim() || draft.attachments?.length)
      ? normalizeOptionalString(draft.projectGitUrl)
      : undefined;
  const customFolder = !projectId && !projectGitUrl && cwd && cwd !== workspace ? cwd : undefined;
  return {
    ...(normalizeOptionalString(draft.key) ? { key: normalizeOptionalString(draft.key) } : {}),
    agentId: normalizeAgentId(draft.agentId),
    message: draft.message,
    ...(draft.mentions?.length
      ? { mentions: draft.mentions.map((mention) => ({ ...mention })) }
      : {}),
    ...(normalizeOptionalString(draft.displayName)
      ? { displayName: normalizeOptionalString(draft.displayName) }
      : {}),
    ...(draft.visibility === "incognito" ? { incognito: true } : {}),
    ...(draft.visibility === "draft" ? { visibility: "draft" } : {}),
    ...(draft.attachments?.length ? { attachments: draft.attachments } : {}),
    ...(catalogId ? { catalogId } : {}),
    ...(category ? { category } : {}),
    ...(!catalogId && model ? { model } : {}),
    ...(!catalogId && contextWindow ? { contextWindow } : {}),
    ...(!catalogId && thinkingLevel ? { thinkingLevel } : {}),
    ...(!catalogId && draft.fastMode !== undefined ? { fastMode: draft.fastMode } : {}),
    ...(draft.toolOverrides ? { toolOverrides: draft.toolOverrides } : {}),
    ...(draft.permissionMode ? { permissionMode: draft.permissionMode } : {}),
    ...(projectId ? { projectId } : {}),
    ...(projectGitUrl ? { projectGitUrl } : {}),
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
