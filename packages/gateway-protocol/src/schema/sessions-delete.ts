import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Deletes a session record and optionally its transcript. */
export const SessionsDeleteParamsSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  deleteTranscript: Type.Optional(Type.Boolean()),
  // Internal compare-and-delete guard for lifecycle-owned cleanup.
  expectedSessionId: Type.Optional(NonEmptyString),
  expectedLifecycleRevision: Type.Optional(NonEmptyString),
  expectedSessionUpdatedAt: Type.Optional(Type.Number({ minimum: 0 })),
  // Internal control: when false, still unbind thread bindings but skip hook emission.
  emitLifecycleHooks: Type.Optional(Type.Boolean()),
  /**
   * Restricts the delete to already-archived sessions (archive-then-delete).
   * operator.write callers must set this; deletes without it require
   * operator.admin.
   */
  archivedOnly: Type.Optional(Type.Boolean()),
});

export const WORKTREE_PRESERVATION_REASONS = [
  "owner-mismatch",
  "busy",
  "foreign-lock",
  "snapshot-failed",
  "cleanup-failed",
] as const;

// Keep this a flat string enum so native protocol generators emit a bounded enum.
export const WorktreePreservationReasonSchema = Type.Enum(WORKTREE_PRESERVATION_REASONS, {
  type: "string",
});

export const PreservedSessionWorktreeSchema = closedObject({
  id: NonEmptyString,
  branch: NonEmptyString,
  path: NonEmptyString,
  reason: WorktreePreservationReasonSchema,
});

/** Result returned after deleting a session and completing owned cleanup. */
export const SessionsDeleteResultSchema = closedObject({
  ok: Type.Literal(true),
  key: NonEmptyString,
  deleted: Type.Boolean(),
  archived: Type.Array(NonEmptyString),
  worktreePreserved: Type.Optional(PreservedSessionWorktreeSchema),
});

export type SessionsDeleteParams = Static<typeof SessionsDeleteParamsSchema>;
export type WorktreePreservationReason = Static<typeof WorktreePreservationReasonSchema>;
export type PreservedSessionWorktree = Static<typeof PreservedSessionWorktreeSchema>;
export type SessionsDeleteResult = Static<typeof SessionsDeleteResultSchema>;
