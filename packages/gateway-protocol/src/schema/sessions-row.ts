import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { SessionClassificationSchema, SessionPeerKindSchema } from "./session-classification.js";
import {
  SESSION_EXPANDED_PARTICIPANT_LIMIT,
  SESSION_PARTICIPANT_LIMIT,
  SessionParticipantSchema,
  SessionParticipantIdentitySchema,
} from "./session-participant.js";
import { SessionSharingRoleSchema, SessionVisibilitySchema } from "./sessions-sharing-values.js";

export const SessionPermissionModeSchema = Type.Union([
  Type.Literal("read-only"),
  Type.Literal("guarded"),
  Type.Literal("workspace"),
  Type.Literal("full"),
]);

export const SessionRunStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("done"),
  Type.Literal("failed"),
  Type.Literal("killed"),
  Type.Literal("timeout"),
]);

export const SessionEntryArchiveReasonSchema = Type.Union([
  Type.Literal("manual"),
  Type.Literal("active-session-cap"),
  Type.Literal("stale-dashboard"),
  Type.Literal("restart-recovery"),
]);

export const SessionToolOverridesSchema = closedObject({
  mcpServers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Boolean())),
  mcpToolsDeny: Type.Optional(
    Type.Record(Type.String({ minLength: 1 }), Type.Array(NonEmptyString)),
  ),
  skills: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Boolean())),
  webSearch: Type.Optional(Type.Boolean()),
});

/** Projected actor that caused a session node to be created. */
export const SessionCreatedActorSchema = closedObject({
  type: Type.Union([Type.Literal("human"), Type.Literal("agent"), Type.Literal("system")]),
  id: Type.Optional(NonEmptyString),
  label: Type.Optional(NonEmptyString),
  /** Durable profile avatar route; absent for actors without a stored profile avatar. */
  avatarUrl: Type.Optional(NonEmptyString),
  /** Display identity is separate from the actor fields used by ownership policy. */
  identity: Type.Optional(SessionParticipantIdentitySchema),
});

/** Mutable responsibility for one session; actor display data is projected at read time. */
export const SessionOwnerSchema = closedObject({
  actor: SessionCreatedActorSchema,
  assignedBy: Type.Optional(SessionCreatedActorSchema),
  assignedAt: Type.Optional(Type.Number({ minimum: 0 })),
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
    icon: Type.Optional(Type.String()),
    /** Named sidebar tint from SESSION_COLOR_IDS; clients map names to theme hues. */
    color: Type.Optional(Type.String()),
    channelAvatarUrl: Type.Optional(NonEmptyString),
    boardFace: Type.Optional(Type.Union([Type.Literal("chat"), Type.Literal("dashboard")])),
    displayName: Type.Optional(Type.String()),
    derivedTitle: Type.Optional(Type.String()),
    lastMessagePreview: Type.Optional(Type.String()),
    channel: Type.Optional(Type.String()),
    /** Stable non-sensitive facts derived from the canonical session route. */
    classification: Type.Optional(SessionClassificationSchema),
    agentId: Type.Optional(NonEmptyString),
    accountId: Type.Optional(NonEmptyString),
    peerKind: Type.Optional(SessionPeerKindSchema),
    isMain: Type.Optional(Type.Boolean()),
    isBackground: Type.Optional(Type.Boolean()),
    chatType: Type.Optional(
      Type.Union([Type.Literal("direct"), Type.Literal("group"), Type.Literal("channel")]),
    ),
    updatedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    archived: Type.Optional(Type.Boolean()),
    archivedAt: Type.Optional(Type.Number()),
    archivedBy: Type.Optional(SessionCreatedActorSchema),
    archiveReason: Type.Optional(SessionEntryArchiveReasonSchema),
    pinned: Type.Optional(Type.Boolean()),
    pinnedAt: Type.Optional(Type.Number()),
    unread: Type.Optional(Type.Boolean()),
    lastReadAt: Type.Optional(Type.Number()),
    markedUnreadAt: Type.Optional(Type.Number()),
    lastActivityAt: Type.Optional(Type.Number()),
    lastInteractionAt: Type.Optional(Type.Number()),
    status: Type.Optional(SessionRunStatusSchema),
    lastRunError: Type.Optional(Type.String()),
    /** Exact run that produced the latest terminal lifecycle projection. */
    lastRunId: Type.Optional(NonEmptyString),
    restartRecoveryStatus: Type.Optional(Type.Literal("tombstoned")),
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
    permissionMode: Type.Optional(SessionPermissionModeSchema),
    permissionModePending: Type.Optional(Type.Boolean()),
    sessionRoot: Type.Optional(Type.String()),
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
    owner: Type.Optional(SessionOwnerSchema),
    participants: Type.Optional(
      Type.Array(SessionParticipantSchema, { maxItems: SESSION_PARTICIPANT_LIMIT }),
    ),
    expandedParticipants: Type.Optional(
      Type.Array(SessionParticipantSchema, { maxItems: SESSION_EXPANDED_PARTICIPANT_LIMIT }),
    ),
    participantCount: Type.Optional(Type.Integer({ minimum: 0 })),
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
    /** Runtime model serving this session while it differs from the selected model. */
    activeModel: Type.Optional(Type.String()),
    activeModelProvider: Type.Optional(Type.String()),
    /** Persisted override provenance; null means inherited, omission means not projected. */
    modelOverrideSource: Type.Optional(
      Type.Union([Type.Literal("user"), Type.Literal("auto"), Type.Null()]),
    ),
    toolOverrides: Type.Optional(SessionToolOverridesSchema),
  },
  { additionalProperties: true },
);

export type SessionCreatedActor = Static<typeof SessionCreatedActorSchema>;
export type SessionPermissionMode = Static<typeof SessionPermissionModeSchema>;
export type SessionOwner = Static<typeof SessionOwnerSchema>;
export type SessionRunStatus = Static<typeof SessionRunStatusSchema>;
export type SessionToolOverrides = Static<typeof SessionToolOverridesSchema>;
export type SessionRow = Static<typeof SessionRowSchema>;
export type SessionEntryArchiveReason = Static<typeof SessionEntryArchiveReasonSchema>;
