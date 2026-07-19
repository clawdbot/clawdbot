import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { ChatAttachmentsSchema } from "./logs-chat.js";
import { NonEmptyString, SessionLabelString } from "./primitives.js";

/** Creates or adopts a session with optional model, thinking, label, and parent linkage. */
export const SessionsCreateParamsSchema = closedObject({
  key: Type.Optional(NonEmptyString),
  agentId: Type.Optional(NonEmptyString),
  label: Type.Optional(SessionLabelString),
  model: Type.Optional(NonEmptyString),
  thinkingLevel: Type.Optional(NonEmptyString),
  catalogId: Type.Optional(NonEmptyString),
  parentSessionKey: Type.Optional(NonEmptyString),
  fork: Type.Optional(
    Type.Boolean({ description: "Fork the parent transcript; requires parentSessionKey." }),
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
  attachments: Type.Optional(ChatAttachmentsSchema),
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
        "Absolute source directory for a managed worktree, or the working directory on execNode. Requires operator.admin.",
    }),
  ),
});
