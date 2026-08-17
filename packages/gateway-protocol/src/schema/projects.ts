import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const StoredProjectIdSchema = Type.String({
  pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
});

export const PROJECTS_LIST_DEFAULT_LIMIT = 50;
export const PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT = 50;
export const PROJECTS_LIST_MAX_IDENTITY_PROBES = 32;

export const ProjectRecordSchema = closedObject({
  id: NonEmptyString,
  displayName: NonEmptyString,
  repoRoot: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Repository checkout root; included only for callers holding operator.write.",
    }),
  ),
  originUrl: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Repository origin URL; included only for callers holding operator.write.",
    }),
  ),
  source: Type.String({ enum: ["workspace", "registered", "cloned"] }),
  agentId: Type.Optional(NonEmptyString),
});

export const ProjectRecentProjectSchema = closedObject({
  kind: Type.Literal("project"),
  projectId: NonEmptyString,
  displayName: NonEmptyString,
});

export const ProjectRecentFolderSchema = closedObject({
  kind: Type.Literal("folder"),
  folder: NonEmptyString,
  displayName: NonEmptyString,
  execNode: Type.Optional(NonEmptyString),
});

export const ProjectRecentSchema = Type.Union([
  ProjectRecentProjectSchema,
  ProjectRecentFolderSchema,
]);

/** One gateway-visible checkout for an observed repository project. */
export const ProjectCheckoutSchema = closedObject({
  runnerId: Type.String({
    minLength: 1,
    description: "Runner hosting this operator.write-scoped checkout.",
  }),
  path: Type.String({
    minLength: 1,
    description: "Physical checkout path returned only to operator.write-capable callers.",
  }),
});

/** Repository identity derived from visible checkout and session state. */
export const ProjectSummarySchema = closedObject({
  name: NonEmptyString,
  originUrl: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Sanitized repository origin returned to operator.write-capable callers.",
    }),
  ),
  checkouts: Type.Array(ProjectCheckoutSchema, {
    minItems: 1,
    maxItems: PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT,
  }),
  lastUsedAt: Type.Number({ minimum: 0 }),
});

export const ProjectsListParamsSchema = closedObject({
  includeObserved: Type.Optional(
    Type.Boolean({
      description: "Compute write-scoped observed checkout groups in addition to projects.",
    }),
  ),
});
export const ProjectsListResultSchema = closedObject({
  projects: Type.Array(ProjectRecordSchema),
  recents: Type.Optional(Type.Array(ProjectRecentSchema, { maxItems: 8 })),
  observedProjects: Type.Optional(
    Type.Array(ProjectSummarySchema, {
      maxItems: PROJECTS_LIST_DEFAULT_LIMIT,
      description: "Observed checkout details returned only to operator.write-capable callers.",
    }),
  ),
});

export const ProjectsRegisterParamsSchema = closedObject({
  path: NonEmptyString,
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});
export const ProjectsRegisterResultSchema = ProjectRecordSchema;

export const ProjectsAddParamsSchema = closedObject({
  gitUrl: Type.String({ minLength: 1, maxLength: 2048 }),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});
export const ProjectsAddResultSchema = ProjectRecordSchema;

export const RemoteProjectSchema = closedObject({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  fullName: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  cloneUrl: Type.String({ minLength: 1, maxLength: 2048 }),
  webUrl: Type.String({ minLength: 1, maxLength: 2048 }),
  private: Type.Boolean(),
});
export const ProjectsSearchRemoteParamsSchema = closedObject({
  query: Type.String({ minLength: 1, maxLength: 200 }),
});
export const ProjectsSearchRemoteResultSchema = closedObject({
  credential: Type.Union([Type.Literal("configured"), Type.Literal("missing")]),
  projects: Type.Array(RemoteProjectSchema, { maxItems: 10 }),
});

export const ProjectsRemoveParamsSchema = closedObject({
  id: StoredProjectIdSchema,
  deleteCheckout: Type.Optional(Type.Boolean()),
});
export const ProjectsRemoveResultSchema = closedObject({ removed: Type.Boolean() });

export type ProjectRecord = Static<typeof ProjectRecordSchema>;
export type ProjectRecent = Static<typeof ProjectRecentSchema>;
export type ProjectCheckout = Static<typeof ProjectCheckoutSchema>;
export type ProjectSummary = Static<typeof ProjectSummarySchema>;
export type ProjectsListParams = Static<typeof ProjectsListParamsSchema>;
export type ProjectsListResult = Static<typeof ProjectsListResultSchema>;
export type ProjectsRegisterParams = Static<typeof ProjectsRegisterParamsSchema>;
export type ProjectsRegisterResult = Static<typeof ProjectsRegisterResultSchema>;
export type ProjectsAddParams = Static<typeof ProjectsAddParamsSchema>;
export type ProjectsAddResult = Static<typeof ProjectsAddResultSchema>;
export type RemoteProject = Static<typeof RemoteProjectSchema>;
export type ProjectsSearchRemoteParams = Static<typeof ProjectsSearchRemoteParamsSchema>;
export type ProjectsSearchRemoteResult = Static<typeof ProjectsSearchRemoteResultSchema>;
export type ProjectsRemoveParams = Static<typeof ProjectsRemoveParamsSchema>;
export type ProjectsRemoveResult = Static<typeof ProjectsRemoveResultSchema>;
