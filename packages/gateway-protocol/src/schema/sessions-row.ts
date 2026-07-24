import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { SessionSharingRoleSchema, SessionVisibilitySchema } from "./sessions-sharing-values.js";

/** Projected actor that caused a session node to be created. */
export const SessionCreatedActorSchema = closedObject({
  type: Type.Union([Type.Literal("human"), Type.Literal("agent"), Type.Literal("system")]),
  id: Type.Optional(NonEmptyString),
  label: Type.Optional(NonEmptyString),
});

/** Stable Gateway session row fields; mutation envelopes may add null tombstones. */
export const SessionRowSchema = Type.Object(
  {
    key: Type.String(),
    sessionId: Type.Optional(Type.String()),
    incognito: Type.Optional(Type.Literal(true)),
    kind: Type.Union([
      Type.Literal("direct"),
      Type.Literal("group"),
      Type.Literal("global"),
      Type.Literal("unknown"),
    ]),
    label: Type.Optional(Type.String()),
    displayName: Type.Optional(Type.String()),
    derivedTitle: Type.Optional(Type.String()),
    lastMessagePreview: Type.Optional(Type.String()),
    channel: Type.Optional(Type.String()),
    chatType: Type.Optional(
      Type.Union([Type.Literal("direct"), Type.Literal("group"), Type.Literal("channel")]),
    ),
    updatedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    archived: Type.Optional(Type.Boolean()),
    archivedAt: Type.Optional(Type.Number()),
    archivedBy: Type.Optional(SessionCreatedActorSchema),
    pinned: Type.Optional(Type.Boolean()),
    pinnedAt: Type.Optional(Type.Number()),
    icon: Type.Optional(Type.String()),
    unread: Type.Optional(Type.Boolean()),
    lastReadAt: Type.Optional(Type.Number()),
    lastActivityAt: Type.Optional(Type.Number()),
    lastInteractionAt: Type.Optional(Type.Number()),
    status: Type.Optional(
      Type.Union([
        Type.Literal("running"),
        Type.Literal("done"),
        Type.Literal("failed"),
        Type.Literal("killed"),
        Type.Literal("timeout"),
      ]),
    ),
    lastRunError: Type.Optional(Type.String()),
    activeLeafEntryId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    spawnedBy: Type.Optional(Type.String()),
    parentSessionKey: Type.Optional(Type.String()),
    controlOwnerSessionKey: Type.Optional(Type.String()),
    childSessions: Type.Optional(Type.Array(Type.String())),
    forkedFromParent: Type.Optional(Type.Boolean()),
    spawnDepth: Type.Optional(Type.Number()),
    subagentRole: Type.Optional(Type.Union([Type.Literal("orchestrator"), Type.Literal("leaf")])),
    subagentControlScope: Type.Optional(
      Type.Union([Type.Literal("children"), Type.Literal("none")]),
    ),
    swarmGroupId: Type.Optional(Type.String()),
    worktree: Type.Optional(
      Type.Object({
        id: Type.String(),
        branch: Type.String(),
        repoRoot: Type.String(),
      }),
    ),
    execNode: Type.Optional(Type.String()),
    execCwd: Type.Optional(Type.String()),
    spawnedWorkspaceDir: Type.Optional(Type.String()),
    spawnedCwd: Type.Optional(Type.String()),
    createdVia: Type.Optional(
      Type.Union([
        Type.Literal("operator"),
        Type.Literal("spawn"),
        Type.Literal("channel"),
        Type.Literal("cron"),
        Type.Literal("talk"),
        Type.Literal("run"),
        Type.Literal("plugin"),
        Type.Literal("internal"),
      ]),
    ),
    createdActor: Type.Optional(SessionCreatedActorSchema),
    visibility: Type.Optional(SessionVisibilitySchema),
    sharingRole: Type.Optional(SessionSharingRoleSchema),
    createdAt: Type.Optional(Type.Number()),
    forkSource: Type.Optional(
      Type.Object({
        sessionKey: Type.String(),
        sessionId: Type.String(),
        entryId: Type.Optional(Type.String()),
      }),
    ),
    previousSessionId: Type.Optional(Type.String()),
    inputTokens: Type.Optional(Type.Number()),
    outputTokens: Type.Optional(Type.Number()),
    totalTokens: Type.Optional(Type.Number()),
    totalTokensFresh: Type.Optional(Type.Boolean()),
    contextTokens: Type.Optional(Type.Number()),
    estimatedCostUsd: Type.Optional(Type.Number()),
    model: Type.Optional(Type.String()),
    modelProvider: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export type SessionCreatedActor = Static<typeof SessionCreatedActorSchema>;
export type SessionRow = Static<typeof SessionRowSchema>;
