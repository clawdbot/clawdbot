// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { PluginJsonValueSchema } from "./plugins.js";
import { NonEmptyString, SessionLabelString } from "./primitives.js";

/**
 * Session protocol schemas.
 *
 * These requests and results cover transcript discovery, lifecycle control,
 * compaction checkpoints, per-session plugin state, and usage reporting. The
 * schemas are shared by dashboard, CLI, ACP, and gateway RPC callers.
 */

/** Reason a compaction checkpoint was created. */
export const SessionCompactionCheckpointReasonSchema = Type.Union([
  Type.Literal("manual"),
  Type.Literal("auto-threshold"),
  Type.Literal("overflow-retry"),
  Type.Literal("timeout-retry"),
]);

/** Start/end event emitted while a session compaction operation runs. */
export const SessionOperationEventSchema = Type.Object(
  {
    operationId: NonEmptyString,
    operation: Type.Literal("compact"),
    phase: Type.Union([Type.Literal("start"), Type.Literal("end")]),
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    ts: Type.Integer({ minimum: 0 }),
    completed: Type.Optional(Type.Boolean()),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Reference to the transcript location before or after compaction. */
export const SessionCompactionTranscriptReferenceSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    sessionFile: Type.Optional(NonEmptyString),
    leafId: Type.Optional(NonEmptyString),
    entryId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Stored compaction checkpoint metadata for branching or restoring a session. */
export const SessionCompactionCheckpointSchema = Type.Object(
  {
    checkpointId: NonEmptyString,
    sessionKey: NonEmptyString,
    sessionId: NonEmptyString,
    createdAt: Type.Integer({ minimum: 0 }),
    reason: SessionCompactionCheckpointReasonSchema,
    tokensBefore: Type.Optional(Type.Integer({ minimum: 0 })),
    tokensAfter: Type.Optional(Type.Integer({ minimum: 0 })),
    summary: Type.Optional(Type.String()),
    firstKeptEntryId: Type.Optional(NonEmptyString),
    preCompaction: SessionCompactionTranscriptReferenceSchema,
    postCompaction: SessionCompactionTranscriptReferenceSchema,
  },
  { additionalProperties: false },
);

/** Session file grouping used by the Control UI session workspace rail. */
export const SessionFileKindSchema = Type.Union([Type.Literal("modified"), Type.Literal("read")]);

/** Session relevance marker for browser entries. */
export const SessionFileRelevanceSchema = Type.Union([
  Type.Literal("modified"),
  Type.Literal("read"),
  Type.Literal("mixed"),
]);

/** One file path referenced by a session transcript. */
export const SessionFileEntrySchema = Type.Object(
  {
    path: NonEmptyString,
    workspacePath: Type.Optional(NonEmptyString),
    name: NonEmptyString,
    kind: SessionFileKindSchema,
    missing: Type.Boolean(),
    size: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    content: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** One file or folder in the session-rooted browser. */
export const SessionFileBrowserEntrySchema = Type.Object(
  {
    path: Type.String(),
    name: NonEmptyString,
    kind: Type.Union([Type.Literal("file"), Type.Literal("directory")]),
    sessionKind: Type.Optional(SessionFileRelevanceSchema),
    size: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

/** Folder listing or search result rooted at the session workspace. */
export const SessionFileBrowserResultSchema = Type.Object(
  {
    path: Type.String(),
    parentPath: Type.Optional(Type.String()),
    search: Type.Optional(Type.String()),
    entries: Type.Array(SessionFileBrowserEntrySchema),
    truncated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Lists files touched by a session transcript. */
export const SessionsFilesListParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    path: Type.Optional(Type.String()),
    search: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** File references visible in one session workspace. */
export const SessionsFilesListResultSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    root: Type.Optional(NonEmptyString),
    files: Type.Array(SessionFileEntrySchema),
    browser: Type.Optional(SessionFileBrowserResultSchema),
  },
  { additionalProperties: false },
);

/** Reads one session-referenced file by path. */
export const SessionsFilesGetParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    path: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Result for reading one session-referenced file. */
export const SessionsFilesGetResultSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    root: Type.Optional(NonEmptyString),
    file: SessionFileEntrySchema,
  },
  { additionalProperties: false },
);

/** Lists sessions with optional scope, activity, label, and preview filters. */
export const SessionsListParamsSchema = Type.Object(
  {
    /**
     * Maximum rows to return. Omitted Gateway RPC calls use a bounded default
     * to keep large session stores from monopolizing the event loop.
     */
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    activeMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
    includeGlobal: Type.Optional(Type.Boolean()),
    includeUnknown: Type.Optional(Type.Boolean()),
    /**
     * Limit returned agent-scoped rows to agents currently present in config.
     * Broad disk discovery remains the default for recovery/ACP consumers.
     */
    configuredAgentsOnly: Type.Optional(Type.Boolean()),
    /**
     * Read first 8KB of each session transcript to derive title from first user message.
     * Performs a file read per session - use `limit` to bound result set on large stores.
     */
    includeDerivedTitles: Type.Optional(Type.Boolean()),
    /**
     * Read last 16KB of each session transcript to extract most recent message preview.
     * Performs a file read per session - use `limit` to bound result set on large stores.
     */
    includeLastMessage: Type.Optional(Type.Boolean()),
    label: Type.Optional(SessionLabelString),
    spawnedBy: Type.Optional(NonEmptyString),
    agentId: Type.Optional(NonEmptyString),
    search: Type.Optional(Type.String()),
    /** True lists archived sessions; false or omitted lists active sessions. */
    archived: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Repairs or removes invalid session records from the selected agent scope. */
export const SessionsCleanupParamsSchema = Type.Object(
  {
    agent: Type.Optional(NonEmptyString),
    allAgents: Type.Optional(Type.Boolean()),
    enforce: Type.Optional(Type.Boolean()),
    activeKey: Type.Optional(NonEmptyString),
    fixMissing: Type.Optional(Type.Boolean()),
    fixDmScope: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Reads short previews for selected session keys. */
export const SessionsPreviewParamsSchema = Type.Object(
  {
    keys: Type.Array(NonEmptyString, { minItems: 1 }),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    maxChars: Type.Optional(Type.Integer({ minimum: 20 })),
  },
  { additionalProperties: false },
);

/** Describes one session and optional derived title/last-message previews. */
export const SessionsDescribeParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    includeDerivedTitles: Type.Optional(Type.Boolean()),
    includeLastMessage: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Resolves a session by key, raw session id, label, or parent/agent scope. */
export const SessionsResolveParamsSchema = Type.Object(
  {
    key: Type.Optional(NonEmptyString),
    sessionId: Type.Optional(NonEmptyString),
    label: Type.Optional(SessionLabelString),
    agentId: Type.Optional(NonEmptyString),
    spawnedBy: Type.Optional(NonEmptyString),
    includeGlobal: Type.Optional(Type.Boolean()),
    includeUnknown: Type.Optional(Type.Boolean()),
    /** Return a successful `{ ok: false }` response when the selector does not match a session. */
    allowMissing: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Creates or adopts a session with optional model, label, and parent linkage. */
export const SessionsCreateParamsSchema = Type.Object(
  {
    key: Type.Optional(NonEmptyString),
    agentId: Type.Optional(NonEmptyString),
    label: Type.Optional(SessionLabelString),
    model: Type.Optional(NonEmptyString),
    parentSessionKey: Type.Optional(NonEmptyString),
    fork: Type.Optional(
      Type.Boolean({ description: "Fork the parent transcript; requires parentSessionKey." }),
    ),
    emitCommandHooks: Type.Optional(Type.Boolean()),
    task: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
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
        description:
          "Managed worktree name; becomes branch openclaw/<name>. Requires worktree=true.",
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
          "Absolute source directory for a managed worktree. Requires worktree=true and operator.admin.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const SessionWorktreeInfoSchema = Type.Object(
  {
    id: NonEmptyString,
    path: NonEmptyString,
    branch: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Result returned after creating or adopting a session. */
export const SessionsCreateResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    key: NonEmptyString,
    sessionId: Type.Optional(NonEmptyString),
    entry: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    runStarted: Type.Optional(Type.Boolean()),
    worktree: Type.Optional(SessionWorktreeInfoSchema),
  },
  { additionalProperties: true },
);

/** Sends one message into an existing session. */
export const SessionsSendParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    message: Type.String(),
    thinking: Type.Optional(Type.String()),
    attachments: Type.Optional(Type.Array(Type.Unknown())),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    idempotencyKey: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Subscribes a client to live message updates for one session. */
export const SessionsMessagesSubscribeParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Removes a live message subscription for one session. */
export const SessionsMessagesUnsubscribeParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Aborts the active or named run for a session. */
export const SessionsAbortParamsSchema = Type.Object(
  {
    key: Type.Optional(NonEmptyString),
    runId: Type.Optional(NonEmptyString),
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Mutable per-session preferences and routing metadata. */
export const SessionsPatchParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    label: Type.Optional(Type.Union([SessionLabelString, Type.Null()])),
    /** User-defined organization bucket ("category", not chat-group); null clears it. */
    category: Type.Optional(Type.Union([SessionLabelString, Type.Null()])),
    archived: Type.Optional(Type.Boolean()),
    pinned: Type.Optional(Type.Boolean()),
    unread: Type.Optional(
      Type.Boolean({ description: "Set true to mark unread; false records the session as read." }),
    ),
    thinkingLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    fastMode: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto"), Type.Null()])),
    verboseLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    traceLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    reasoningLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    responseUsage: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("tokens"),
        Type.Literal("full"),
        // Backward compat with older clients/stores.
        Type.Literal("on"),
        Type.Null(),
      ]),
    ),
    elevatedLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    execHost: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    execSecurity: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    execAsk: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    execNode: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    model: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    spawnedBy: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    spawnedWorkspaceDir: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    spawnedCwd: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    spawnDepth: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    subagentRole: Type.Optional(
      Type.Union([Type.Literal("orchestrator"), Type.Literal("leaf"), Type.Null()]),
    ),
    subagentControlScope: Type.Optional(
      Type.Union([Type.Literal("children"), Type.Literal("none"), Type.Null()]),
    ),
    inheritedToolAllow: Type.Optional(Type.Union([Type.Array(NonEmptyString), Type.Null()])),
    inheritedToolDeny: Type.Optional(Type.Union([Type.Array(NonEmptyString), Type.Null()])),
    sendPolicy: Type.Optional(
      Type.Union([Type.Literal("allow"), Type.Literal("deny"), Type.Null()]),
    ),
    groupActivation: Type.Optional(
      Type.Union([Type.Literal("mention"), Type.Literal("always"), Type.Null()]),
    ),
  },
  { additionalProperties: false },
);

/** Updates or clears one plugin namespace value on a session record. */
export const SessionsPluginPatchParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    pluginId: NonEmptyString,
    namespace: NonEmptyString,
    value: Type.Optional(PluginJsonValueSchema),
    unset: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Result returned after patching session plugin state. */
export const SessionsPluginPatchResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    key: NonEmptyString,
    value: Type.Optional(PluginJsonValueSchema),
  },
  { additionalProperties: false },
);

/** Resets a session to a new or reset transcript state. */
export const SessionsResetParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    reason: Type.Optional(Type.Union([Type.Literal("new"), Type.Literal("reset")])),
  },
  { additionalProperties: false },
);

/** Deletes a session record and optionally its transcript. */
export const SessionsDeleteParamsSchema = Type.Object(
  {
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
  },
  { additionalProperties: false },
);

/** Lists the gateway-owned custom session group catalog (names + order). */
export const SessionsGroupsListParamsSchema = Type.Object({}, { additionalProperties: false });

/** One custom session group catalog entry. */
export const SessionGroupSchema = Type.Object(
  {
    name: SessionLabelString,
    position: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/** Custom session group catalog in display order. */
export const SessionsGroupsListResultSchema = Type.Object(
  { groups: Type.Array(SessionGroupSchema) },
  { additionalProperties: false },
);

/** Replaces the ordered group catalog; creates listed names, keeps member categories untouched. */
export const SessionsGroupsPutParamsSchema = Type.Object(
  { names: Type.Array(SessionLabelString, { maxItems: 200 }) },
  { additionalProperties: false },
);

/** Renames a group and repoints every member session's category. */
export const SessionsGroupsRenameParamsSchema = Type.Object(
  { name: SessionLabelString, to: SessionLabelString },
  { additionalProperties: false },
);

/** Deletes a group and clears every member session's category. */
export const SessionsGroupsDeleteParamsSchema = Type.Object(
  { name: SessionLabelString },
  { additionalProperties: false },
);

/** Result for group catalog mutations, with member sessions updated where applicable. */
export const SessionsGroupsMutationResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    groups: Type.Array(SessionGroupSchema),
    updatedSessions: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

/** Requests manual compaction for a session transcript. */
export const SessionsCompactParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    maxLines: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

/** Lists compaction checkpoints for one session. */
export const SessionsCompactionListParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Reads one compaction checkpoint by id. */
export const SessionsCompactionGetParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    checkpointId: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Creates a new branch from a compaction checkpoint. */
export const SessionsCompactionBranchParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    checkpointId: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Restores an existing session to a compaction checkpoint. */
export const SessionsCompactionRestoreParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    checkpointId: NonEmptyString,
  },
  { additionalProperties: false },
);

/** List response for session compaction checkpoints. */
export const SessionsCompactionListResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    key: NonEmptyString,
    checkpoints: Type.Array(SessionCompactionCheckpointSchema),
  },
  { additionalProperties: false },
);

/** Get response for a single compaction checkpoint. */
export const SessionsCompactionGetResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    key: NonEmptyString,
    checkpoint: SessionCompactionCheckpointSchema,
  },
  { additionalProperties: false },
);

/** Branch response with the newly created session key and entry metadata. */
export const SessionsCompactionBranchResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    sourceKey: NonEmptyString,
    key: NonEmptyString,
    sessionId: NonEmptyString,
    checkpoint: SessionCompactionCheckpointSchema,
    entry: Type.Object(
      {
        sessionId: NonEmptyString,
        updatedAt: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: false },
);

/** Restore response with updated session entry metadata. */
export const SessionsCompactionRestoreResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    key: NonEmptyString,
    sessionId: NonEmptyString,
    checkpoint: SessionCompactionCheckpointSchema,
    entry: Type.Object(
      {
        sessionId: NonEmptyString,
        updatedAt: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: false },
);

/** Usage report query across one session, one agent, or all agent sessions. */
export const SessionsUsageParamsSchema = Type.Object(
  {
    /** Specific session key to analyze; if omitted returns sessions for the effective agent. */
    key: Type.Optional(NonEmptyString),
    /** Agent scope for list-style usage queries. */
    agentId: Type.Optional(NonEmptyString),
    /** Explicit all-agent scope for list-style usage queries. */
    agentScope: Type.Optional(Type.Literal("all")),
    /** Start date for range filter (YYYY-MM-DD). */
    startDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    /** End date for range filter (YYYY-MM-DD). */
    endDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    /** How start/end dates should be interpreted. Defaults to UTC when omitted. */
    mode: Type.Optional(
      Type.Union([Type.Literal("utc"), Type.Literal("gateway"), Type.Literal("specific")]),
    ),
    /** Preset range for usage queries when explicit start/end dates are omitted. */
    range: Type.Optional(
      Type.Union([
        Type.Literal("7d"),
        Type.Literal("30d"),
        Type.Literal("90d"),
        Type.Literal("1y"),
        Type.Literal("all"),
      ]),
    ),
    /** Usage row grouping. `family` rolls up known rotated session ids for a logical key. */
    groupBy: Type.Optional(Type.Union([Type.Literal("instance"), Type.Literal("family")])),
    /** Backward-compatible alias for requesting family grouping. */
    includeHistorical: Type.Optional(Type.Boolean()),
    /** UTC offset to use when mode is `specific` (for example, UTC-4 or UTC+5:30). */
    utcOffset: Type.Optional(Type.String({ pattern: "^UTC[+-]\\d{1,2}(?::[0-5]\\d)?$" })),
    /** IANA time zone for `specific`; preferred over `utcOffset`, which remains a compatibility fallback. */
    timeZone: Type.Optional(NonEmptyString),
    /** Maximum sessions to return (default 50). */
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    /** Include context weight breakdown (systemPromptReport). */
    includeContextWeight: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
