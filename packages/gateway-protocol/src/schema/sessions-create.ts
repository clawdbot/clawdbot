import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { HumanMentionsSchema } from "./human-mentions.js";
import { ChatAttachmentsSchema } from "./logs-chat.js";
import { NonEmptyString, SessionLabelString } from "./primitives.js";
import {
  SessionPermissionModeSchema,
  SessionRepositorySourceSchema,
  SessionToolOverridesSchema,
} from "./sessions-row.js";
import { SessionVisibilitySchema } from "./sessions-sharing-values.js";

export const SESSION_CREATE_RETRY_WINDOW_MS = 4 * 60_000;
export const SESSION_CREATE_IDEMPOTENCY_RETENTION_MS = 5 * 60_000;

/** Creates or adopts a session with optional model, thinking, fast mode, label, and parent linkage. */
export const SessionsCreateParamsSchema = closedObject({
  key: Type.Optional(NonEmptyString),
  idempotencyKey: Type.Optional(NonEmptyString),
  agentId: Type.Optional(NonEmptyString),
  label: Type.Optional(SessionLabelString),
  displayName: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 500,
      description:
        "Prepared presentation title for a newly created session. Unlike label it is not unique and never claims a label; ignored when adopting an existing key.",
    }),
  ),
  category: Type.Optional(SessionLabelString),
  model: Type.Optional(NonEmptyString),
  contextWindow: Type.Optional(NonEmptyString),
  thinkingLevel: Type.Optional(NonEmptyString),
  fastMode: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
  permissionMode: Type.Optional(SessionPermissionModeSchema),
  toolOverrides: Type.Optional(SessionToolOverridesSchema),
  incognito: Type.Optional(Type.Boolean()),
  visibility: Type.Optional(SessionVisibilitySchema),
  catalogId: Type.Optional(NonEmptyString),
  parentSessionKey: Type.Optional(NonEmptyString),
  spawnDepth: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Spawn-lineage depth for spawn-owned creations (visible subagent sessions); requires parentSessionKey. Omitted creations persist as root sessions (depth 0).",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({ description: "Fork the parent transcript; requires parentSessionKey." }),
  ),
  forkFrom: Type.Optional(
    Type.Literal("last-completed", {
      description:
        "Fork through the parent's last completed assistant message; requires fork=true.",
    }),
  ),
  emitCommandHooks: Type.Optional(Type.Boolean()),
  succeedsParent: Type.Optional(
    Type.Boolean({
      description:
        "When sessions.create creates a distinct child, whether that child succeeds its parent and emits the parent's terminal session_end. Requires parentSessionKey and emitCommandHooks. False keeps the parent active; omission preserves legacy behavior.",
    }),
  ),
  task: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  mentions: Type.Optional(HumanMentionsSchema),
  attachments: Type.Optional(ChatAttachmentsSchema),
  projectId: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Start in a registered project; operator.write.",
    }),
  ),
  projectGitUrl: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 2048,
      description: "Prepare a remote project before the initial agent turn; operator.write.",
    }),
  ),
  /** Remote-owned source; create, dispatch, then send the initial turn. */
  repository: Type.Optional(SessionRepositorySourceSchema),
  worktree: Type.Optional(Type.Boolean()),
  worktreeBaseRef: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Base ref for the new managed worktree branch. Requires worktree=true.",
    }),
  ),
  worktreeName: Type.Optional(
    Type.String({
      pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
      description: "Managed worktree name; becomes branch openclaw/<name>. Requires worktree=true.",
    }),
  ),
  execNode: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Bind session exec to host=node with this node id/name. Requires operator.admin.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Absolute Gateway working directory, managed-worktree source directory, or working directory on execNode. Gateway paths outside configured agent workspaces and all execNode paths require operator.admin.",
    }),
  ),
});
