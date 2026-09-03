import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const WorktreeNameSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" });

const WorktreeRunEndCleanupSchema = Type.Union([
  closedObject({
    outcome: Type.String({
      enum: [
        "removed-lossless",
        "retained-busy",
        "retained-dirty",
        "retained-unpushed",
        "retained-provisioned-drift",
      ],
    }),
    at: Type.Integer({ minimum: 0 }),
  }),
  closedObject({
    outcome: Type.Literal("failed"),
    at: Type.Integer({ minimum: 0 }),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  }),
]);

export const WorktreeRecordSchema = closedObject({
  id: NonEmptyString,
  name: WorktreeNameSchema,
  repoFingerprint: Type.String({ pattern: "^[a-f0-9]{16}$" }),
  repoRoot: NonEmptyString,
  path: NonEmptyString,
  branch: NonEmptyString,
  baseRef: NonEmptyString,
  ownerKind: Type.String({ enum: ["manual", "workboard", "session"] }),
  ownerId: Type.Optional(NonEmptyString),
  snapshotRef: Type.Optional(NonEmptyString),
  createdAt: Type.Integer({ minimum: 0 }),
  lastActiveAt: Type.Integer({ minimum: 0 }),
  removedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  runEndCleanup: Type.Optional(WorktreeRunEndCleanupSchema),
});

export const WorktreesListParamsSchema = closedObject({});
export const WorktreesListResultSchema = closedObject({
  worktrees: Type.Array(WorktreeRecordSchema),
});

export const WorktreesCreateParamsSchema = closedObject({
  repoRoot: NonEmptyString,
  name: Type.Optional(WorktreeNameSchema),
  baseRef: Type.Optional(NonEmptyString),
});

export const WorktreesRemoveParamsSchema = closedObject({
  id: NonEmptyString,
  force: Type.Optional(Type.Boolean()),
});
export const WorktreesRemoveResultSchema = closedObject({
  removed: Type.Boolean(),
  snapshotRef: Type.Optional(NonEmptyString),
  /** Why the pre-removal snapshot failed; removal may have stopped or continued without one. */
  snapshotError: Type.Optional(NonEmptyString),
});

// Keep flat string enums for native enum generation; the schema test pins
// TypeBox Value.Check rejection of unknown members on our supported version.
export const WorktreeRepositoryStatusSchema = Type.String({
  enum: ["git", "not_git", "unavailable"],
});
export const WorktreeAllocationStatusSchema = Type.String({
  enum: ["available", "insufficient-space", "unavailable"],
});
export const WorktreesBranchesParamsSchema = closedObject({
  repoRoot: NonEmptyString,
  includeRepositoryStatus: Type.Optional(Type.Boolean()),
  includeAllocationStatus: Type.Optional(Type.Boolean()),
  baseRef: Type.Optional(NonEmptyString),
});
export const WorktreeBranchSchema = closedObject({
  name: NonEmptyString,
  kind: Type.Union([Type.Literal("local"), Type.Literal("remote")]),
});
export const WorktreesBranchesResultSchema = closedObject({
  branches: Type.Array(WorktreeBranchSchema),
  defaultBranch: Type.Optional(NonEmptyString),
  headBranch: Type.Optional(NonEmptyString),
  repositoryStatus: Type.Optional(WorktreeRepositoryStatusSchema),
  allocationStatus: Type.Optional(WorktreeAllocationStatusSchema),
});

export const WorktreesRestoreParamsSchema = closedObject({ id: NonEmptyString });
export const WorktreesGcParamsSchema = closedObject({});
export const WorktreesGcResultSchema = closedObject({
  removed: Type.Array(NonEmptyString),
  orphansDeleted: Type.Integer({ minimum: 0 }),
  snapshotsPruned: Type.Integer({ minimum: 0 }),
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type WorktreeRecord = Static<typeof WorktreeRecordSchema>;
export type WorktreesListParams = Static<typeof WorktreesListParamsSchema>;
export type WorktreesListResult = Static<typeof WorktreesListResultSchema>;
export type WorktreesCreateParams = Static<typeof WorktreesCreateParamsSchema>;
export type WorktreesRemoveParams = Static<typeof WorktreesRemoveParamsSchema>;
export type WorktreesRemoveResult = Static<typeof WorktreesRemoveResultSchema>;
export type WorktreesRestoreParams = Static<typeof WorktreesRestoreParamsSchema>;
export type WorktreesGcParams = Static<typeof WorktreesGcParamsSchema>;
export type WorktreesGcResult = Static<typeof WorktreesGcResultSchema>;
export type WorktreeBranch = Static<typeof WorktreeBranchSchema>;
export type WorktreeRepositoryStatus = "git" | "not_git" | "unavailable";
export type WorktreeAllocationStatus = "available" | "insufficient-space" | "unavailable";
export type WorktreesBranchesParams = Static<typeof WorktreesBranchesParamsSchema>;
export type WorktreesBranchesResult = Static<typeof WorktreesBranchesResultSchema>;
