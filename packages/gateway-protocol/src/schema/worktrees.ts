import type { Static } from "typebox";
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

const WorktreeNameSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" });

export const WorktreeRecordSchema = Type.Object(
  {
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
  },
  { additionalProperties: false },
);

export const WorktreesListParamsSchema = Type.Object({}, { additionalProperties: false });
export const WorktreesListResultSchema = Type.Object(
  { worktrees: Type.Array(WorktreeRecordSchema) },
  { additionalProperties: false },
);

export const WorktreesCreateParamsSchema = Type.Object(
  {
    repoRoot: NonEmptyString,
    name: Type.Optional(WorktreeNameSchema),
    baseRef: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const WorktreesRemoveParamsSchema = Type.Object(
  { id: NonEmptyString, force: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);
export const WorktreesRemoveResultSchema = Type.Object(
  {
    removed: Type.Boolean(),
    snapshotRef: Type.Optional(NonEmptyString),
    /** Why the pre-removal snapshot failed; present only on forced removals that continued without one. */
    snapshotError: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const WorktreesBranchesParamsSchema = Type.Object(
  { repoRoot: NonEmptyString },
  { additionalProperties: false },
);
export const WorktreeBranchSchema = Type.Object(
  {
    name: NonEmptyString,
    kind: Type.Union([Type.Literal("local"), Type.Literal("remote")]),
  },
  { additionalProperties: false },
);
export const WorktreesBranchesResultSchema = Type.Object(
  {
    branches: Type.Array(WorktreeBranchSchema),
    defaultBranch: Type.Optional(NonEmptyString),
    headBranch: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const WorktreesRestoreParamsSchema = Type.Object(
  { id: NonEmptyString },
  { additionalProperties: false },
);
export const WorktreesGcParamsSchema = Type.Object({}, { additionalProperties: false });
export const WorktreesGcResultSchema = Type.Object(
  {
    removed: Type.Array(NonEmptyString),
    orphansDeleted: Type.Integer({ minimum: 0 }),
    snapshotsPruned: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

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
export type WorktreesBranchesParams = Static<typeof WorktreesBranchesParamsSchema>;
export type WorktreesBranchesResult = Static<typeof WorktreesBranchesResultSchema>;
