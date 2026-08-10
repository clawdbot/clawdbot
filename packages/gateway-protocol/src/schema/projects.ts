import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const StoredProjectIdSchema = Type.String({
  pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
});

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

export const ProjectsListParamsSchema = closedObject({});
export const ProjectsListResultSchema = closedObject({
  projects: Type.Array(ProjectRecordSchema),
});

export const ProjectsRegisterParamsSchema = closedObject({
  path: NonEmptyString,
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});
export const ProjectsRegisterResultSchema = ProjectRecordSchema;

export const ProjectsRemoveParamsSchema = closedObject({ id: StoredProjectIdSchema });
export const ProjectsRemoveResultSchema = closedObject({ removed: Type.Boolean() });

export type ProjectRecord = Static<typeof ProjectRecordSchema>;
export type ProjectsListParams = Static<typeof ProjectsListParamsSchema>;
export type ProjectsListResult = Static<typeof ProjectsListResultSchema>;
export type ProjectsRegisterParams = Static<typeof ProjectsRegisterParamsSchema>;
export type ProjectsRegisterResult = Static<typeof ProjectsRegisterResultSchema>;
export type ProjectsRemoveParams = Static<typeof ProjectsRemoveParamsSchema>;
export type ProjectsRemoveResult = Static<typeof ProjectsRemoveResultSchema>;
