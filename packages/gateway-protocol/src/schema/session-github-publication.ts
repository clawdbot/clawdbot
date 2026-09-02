import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import {
  PersonalGitHubAccountSchema,
  PersonalGitHubGenerationSchema,
  PersonalGitHubStatusSchema,
} from "./users.js";

const SharedGitHubPublicationSourceSchema = Type.Union([
  Type.Literal("system-detected"),
  Type.Literal("system-configured"),
  Type.Literal("agent-override"),
]);
export const GitHubPublicationPublisherSchema = closedObject({
  source: Type.Union([Type.Literal("personal"), ...SharedGitHubPublicationSourceSchema.anyOf]),
  ...PersonalGitHubAccountSchema.properties,
});
const SharedGitHubPublicationPublisherSchema = closedObject({
  ...GitHubPublicationPublisherSchema.properties,
  source: SharedGitHubPublicationSourceSchema,
});
export const GitHubPublicationSelectionSchema = Type.Union([
  closedObject({
    source: Type.Literal("shared"),
    expected: Type.Optional(SharedGitHubPublicationPublisherSchema),
  }),
  closedObject({
    source: Type.Literal("personal"),
    generation: PersonalGitHubGenerationSchema,
    account: PersonalGitHubAccountSchema,
  }),
]);

export const GitHubPublicationTitleSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\r\\n]*\\S[^\\r\\n]*$",
});
export const GitHubPublicationBodySchema = Type.String({ minLength: 1, maxLength: 8 * 1024 });

export const SessionGitHubPublishParamsSchema = closedObject({
  sessionKey: Type.Optional(NonEmptyString),
  idempotencyKey: NonEmptyString,
  title: Type.Optional(GitHubPublicationTitleSchema),
  body: Type.Optional(GitHubPublicationBodySchema),
  selection: Type.Optional(GitHubPublicationSelectionSchema),
});

const SessionGitHubPublicationBaseSchema = {
  requestId: NonEmptyString,
  // Optional for responses from older shared workers; every current Gateway response includes it.
  publisher: Type.Optional(GitHubPublicationPublisherSchema),
  effect: Type.Optional(
    closedObject({
      kind: Type.Union([Type.Literal("push"), Type.Literal("pull_request")]),
      status: Type.Union([Type.Literal("dispatched"), Type.Literal("observed")]),
      headCommit: Type.Optional(Type.String({ maxLength: 64 })),
      url: Type.Optional(Type.String({ maxLength: 2048 })),
    }),
  ),
};

export const SessionGitHubPublicationRequestedSchema = closedObject({
  ...SessionGitHubPublicationBaseSchema,
  status: Type.Literal("requested"),
  message: NonEmptyString,
});
export const SessionGitHubPublicationPublishingSchema = closedObject({
  ...SessionGitHubPublicationBaseSchema,
  status: Type.Literal("publishing"),
  message: NonEmptyString,
});
export const SessionGitHubPublicationPublishedSchema = closedObject({
  ...SessionGitHubPublicationBaseSchema,
  status: Type.Literal("published"),
  url: NonEmptyString,
  repository: NonEmptyString,
  branch: NonEmptyString,
  headCommit: NonEmptyString,
});
export const SessionGitHubPublicationFailedSchema = closedObject({
  ...SessionGitHubPublicationBaseSchema,
  status: Type.Literal("failed"),
  code: Type.Union([
    Type.Literal("identity_changed"),
    Type.Literal("identity_unavailable"),
    Type.Literal("session_changed"),
    Type.Literal("workspace_changed"),
    Type.Literal("not_git"),
    Type.Literal("not_github"),
    Type.Literal("no_changes"),
    Type.Literal("push_rejected"),
    Type.Literal("github_rejected"),
    Type.Literal("unavailable"),
  ]),
  message: NonEmptyString,
  nextAction: NonEmptyString,
});

export const SessionGitHubPublicationNeedsConfirmationSchema = closedObject({
  ...SessionGitHubPublicationBaseSchema,
  status: Type.Literal("needs_confirmation"),
  message: NonEmptyString,
});
export const SessionGitHubPublicationResultSchema = Type.Union([
  SessionGitHubPublicationRequestedSchema,
  SessionGitHubPublicationPublishingSchema,
  SessionGitHubPublicationPublishedSchema,
  SessionGitHubPublicationFailedSchema,
  SessionGitHubPublicationNeedsConfirmationSchema,
]);

export const SessionGitHubOptionsParamsSchema = closedObject({ sessionKey: NonEmptyString });
export const SessionGitHubStatusParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  requestId: PersonalGitHubGenerationSchema,
});
export const SessionGitHubConfirmParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  requestId: PersonalGitHubGenerationSchema,
  generation: PersonalGitHubGenerationSchema,
  account: PersonalGitHubAccountSchema,
  requestDigest: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]+$" }),
});
export const SessionGitHubStatusResultSchema = closedObject({
  result: SessionGitHubPublicationResultSchema,
  confirmation: Type.Union([
    Type.Null(),
    closedObject({
      requestDigest: Type.String({ minLength: 64, maxLength: 64 }),
      generation: PersonalGitHubGenerationSchema,
      account: PersonalGitHubAccountSchema,
      pushRepository: Type.String({ maxLength: 256 }),
      repository: Type.String({ maxLength: 256 }),
      branch: Type.String({ maxLength: 256 }),
      baseBranch: Type.String({ maxLength: 256 }),
      sourceHeadCommit: Type.String({ maxLength: 64 }),
      sourceIndexTree: Type.String({ maxLength: 64 }),
      workspaceTree: Type.String({ maxLength: 64 }),
    }),
  ]),
});

export const SessionGitHubOptionsResultSchema = closedObject({
  personal: Type.Union([PersonalGitHubStatusSchema, Type.Null()]),
  shared: Type.Union([SharedGitHubPublicationPublisherSchema, Type.Null()]),
  pendingPersonal: Type.Union([SessionGitHubStatusResultSchema, Type.Null()]),
});

export type GitHubPublicationPublisher = Static<typeof GitHubPublicationPublisherSchema>;
export type GitHubPublicationSelection = Static<typeof GitHubPublicationSelectionSchema>;
export type SessionGitHubConfirmParams = Static<typeof SessionGitHubConfirmParamsSchema>;
export type SessionGitHubStatusResult = Static<typeof SessionGitHubStatusResultSchema>;

export type SessionGitHubPublishParams = Static<typeof SessionGitHubPublishParamsSchema>;
export type SessionGitHubPublicationRequested = Static<
  typeof SessionGitHubPublicationRequestedSchema
>;
export type SessionGitHubPublicationPublishing = Static<
  typeof SessionGitHubPublicationPublishingSchema
>;
export type SessionGitHubPublicationPublished = Static<
  typeof SessionGitHubPublicationPublishedSchema
>;
export type SessionGitHubPublicationFailed = Static<typeof SessionGitHubPublicationFailedSchema>;
export type SessionGitHubPublicationResult = Static<typeof SessionGitHubPublicationResultSchema>;
