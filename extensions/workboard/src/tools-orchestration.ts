import type { WorkboardCard } from "@openclaw/workboard-contract";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { AgentToolResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { redactClaimToken } from "./card-redaction.js";
import type { WorkboardStore } from "./store.js";
import { cardIdField, claimTokenField, strictObject } from "./tools-card-mutations.js";

type ScopedCardParams = {
  record: Record<string, unknown>;
  id: string;
  scope: { ownerId: string; token?: string };
};

type WorkboardCardMutation = (
  id: string,
  record: Record<string, unknown>,
  scope: ScopedCardParams["scope"],
) => Promise<WorkboardCard>;

const CardIdSchema = strictObject({
  id: cardIdField(),
  token: claimTokenField(),
});
const ScopedClaimTokenField = claimTokenField("Claim token for claimed cards.");
const OptionalNextStatusField = Type.Optional(
  Type.String({ description: "Optional next status." }),
);
const OptionalOperatorNoteField = Type.Optional(
  Type.String({ description: "Optional operator note." }),
);

export function createWorkboardOrchestrationTools(params: {
  store: WorkboardStore;
  ownerId: string;
  requireScopedCard: (
    store: WorkboardStore,
    cardId: string,
    ownerId: string,
    token?: string,
  ) => Promise<WorkboardCard>;
  readScopedCardToolParams: (rawParams: unknown) => Promise<ScopedCardParams>;
  readClaimedCardToolParams: (rawParams: unknown) => Promise<ScopedCardParams>;
  runScopedCardMutation: (
    rawParams: unknown,
    mutate: WorkboardCardMutation,
  ) => Promise<AgentToolResult<{ card: WorkboardCard }>>;
  redactedCardResult: (card: WorkboardCard) => AgentToolResult<{ card: WorkboardCard }>;
}): AnyAgentTool[] {
  const {
    store,
    ownerId,
    requireScopedCard,
    readScopedCardToolParams,
    readClaimedCardToolParams,
    runScopedCardMutation,
    redactedCardResult,
  } = params;
  return [
    {
      name: "workboard_boards",
      label: "Workboard Boards",
      description: "List Workboard board namespaces with active, archived, and status counts.",
      parameters: strictObject({}),
      execute: async () => jsonResult(await store.listBoards()),
    },
    {
      name: "workboard_board_create",
      label: "Workboard Board Create",
      description: "Create or update a Workboard board namespace with persisted SQLite metadata.",
      parameters: strictObject({
        id: Type.String({ description: "Board id." }),
        name: Type.Optional(Type.String({ description: "Display name." })),
        description: Type.Optional(Type.String({ description: "Board description." })),
        icon: Type.Optional(Type.String({ description: "Short icon or label." })),
        color: Type.Optional(Type.String({ description: "Display color token." })),
        automationJobId: Type.Optional(
          Type.String({
            description: "Owning automation job id.",
            minLength: 1,
            maxLength: 128,
          }),
        ),
        defaultWorkspace: Type.Optional(
          strictObject({
            kind: Type.String({ description: "scratch, dir, or worktree." }),
            path: Type.Optional(Type.String({ description: "Absolute dir/worktree path." })),
            branch: Type.Optional(Type.String({ description: "Suggested branch." })),
          }),
        ),
        orchestration: Type.Optional(
          strictObject({
            autoDecompose: Type.Optional(
              Type.Boolean({ description: "Mark ready triage cards for decomposition." }),
            ),
            autoDecomposePerDispatch: Type.Optional(
              Type.Number({ description: "Maximum orchestration candidates per dispatch." }),
            ),
            defaultAssignee: Type.Optional(Type.String({ description: "Default assignee." })),
            orchestratorProfile: Type.Optional(
              Type.String({ description: "Orchestrator profile id." }),
            ),
          }),
        ),
      }),
      execute: async (_toolCallId, rawParams) =>
        jsonResult({ board: await store.upsertBoard(asNonArrayRecord(rawParams)) }),
    },
    {
      name: "workboard_board_archive",
      label: "Workboard Board Archive",
      description: "Archive or restore persisted Workboard board metadata.",
      parameters: strictObject({
        id: Type.String({ description: "Board id." }),
        archived: Type.Optional(Type.Boolean({ description: "Archive when true." })),
      }),
      execute: async (_toolCallId, rawParams) => {
        const record = asNonArrayRecord(rawParams);
        return jsonResult({ board: await store.archiveBoard(record.id, record.archived) });
      },
    },
    {
      name: "workboard_board_delete",
      label: "Workboard Board Delete",
      description: "Delete an empty non-default Workboard board metadata record.",
      parameters: strictObject({ id: Type.String({ description: "Board id." }) }),
      execute: async (_toolCallId, rawParams) =>
        jsonResult(await store.deleteBoard(asNonArrayRecord(rawParams).id)),
    },
    {
      name: "workboard_stats",
      label: "Workboard Stats",
      description: "Summarize Workboard counts by status and assignee for one board or all boards.",
      parameters: strictObject({
        boardId: Type.Optional(Type.String({ description: "Optional board id filter." })),
      }),
      execute: async (_toolCallId, rawParams) => {
        const record = asNonArrayRecord(rawParams);
        return jsonResult(await store.stats({ boardId: record.boardId }));
      },
    },
    {
      name: "workboard_runs",
      label: "Workboard Runs",
      description: "List persisted Workboard run attempts for one card.",
      parameters: CardIdSchema,
      execute: async (_toolCallId, rawParams) => {
        const id = readStringParam(asNonArrayRecord(rawParams), "id", { required: true });
        const result = await store.runs(id);
        return jsonResult({ ...result, card: redactClaimToken(result.card) });
      },
    },
    {
      name: "workboard_specify",
      label: "Workboard Specify",
      description:
        "Turn a rough triage/backlog Workboard card into a specified todo card after reasoning through the requirements.",
      parameters: strictObject({
        id: Type.String({ description: "Workboard card id." }),
        title: Type.Optional(Type.String({ description: "Clarified title." })),
        notes: Type.Optional(
          Type.String({ description: "Clarified notes or acceptance criteria." }),
        ),
        agentId: Type.Optional(Type.String({ description: "Assigned agent id." })),
        priority: Type.Optional(Type.String({ description: "low, normal, high, or urgent." })),
        labels: Type.Optional(Type.Array(Type.String(), { description: "Card labels." })),
        boardId: Type.Optional(Type.String({ description: "Board id." })),
        tenant: Type.Optional(Type.String({ description: "Tenant or routing namespace." })),
        skills: Type.Optional(Type.Array(Type.String(), { description: "Suggested skills." })),
        workspace: Type.Optional(
          strictObject({
            kind: Type.String({ description: "scratch, dir, or worktree." }),
            path: Type.Optional(Type.String({ description: "Absolute dir/worktree path." })),
            branch: Type.Optional(Type.String({ description: "Suggested branch." })),
          }),
        ),
        maxRuntimeSeconds: Type.Optional(Type.Number({ description: "Runtime budget." })),
        maxRetries: Type.Optional(Type.Number({ description: "Retry budget." })),
        summary: Type.Optional(Type.String({ description: "Specification summary comment." })),
        token: Type.Optional(Type.String({ description: "Claim token for claimed cards." })),
      }),
      execute: async (_toolCallId, rawParams) => {
        const record = asNonArrayRecord(rawParams);
        const id = readStringParam(record, "id", { required: true });
        const token = typeof record.token === "string" ? record.token : undefined;
        await requireScopedCard(store, id, ownerId, token);
        return jsonResult({
          card: redactClaimToken(await store.specify(id, record, { ownerId, token: record.token })),
        });
      },
    },
    {
      name: "workboard_decompose",
      label: "Workboard Decompose",
      description:
        "Fan out a Workboard card into linked child cards and optionally complete the parent orchestration card.",
      parameters: strictObject({
        id: Type.String({ description: "Parent Workboard card id." }),
        token: Type.Optional(Type.String({ description: "Claim token for claimed cards." })),
        summary: Type.Optional(Type.String({ description: "Decomposition summary." })),
        completeParent: Type.Optional(
          Type.Boolean({
            description: "Complete the parent after child creation. Default true.",
          }),
        ),
        children: Type.Array(
          strictObject({
            title: Type.String({ description: "Child title." }),
            notes: Type.Optional(Type.String({ description: "Child notes." })),
            agentId: Type.Optional(Type.String({ description: "Assigned agent id." })),
            priority: Type.Optional(Type.String({ description: "low, normal, high, or urgent." })),
            labels: Type.Optional(Type.Array(Type.String())),
            boardId: Type.Optional(Type.String()),
            tenant: Type.Optional(Type.String()),
            skills: Type.Optional(Type.Array(Type.String())),
            workspace: Type.Optional(
              strictObject({
                kind: Type.String({ description: "scratch, dir, or worktree." }),
                path: Type.Optional(Type.String({ description: "Absolute dir/worktree path." })),
                branch: Type.Optional(Type.String({ description: "Suggested branch." })),
              }),
            ),
            maxRuntimeSeconds: Type.Optional(Type.Number()),
            maxRetries: Type.Optional(Type.Number()),
            idempotencyKey: Type.Optional(Type.String()),
          }),
        ),
      }),
      execute: async (_toolCallId, rawParams) => {
        const record = asNonArrayRecord(rawParams);
        const id = readStringParam(record, "id", { required: true });
        const token = typeof record.token === "string" ? record.token : undefined;
        await requireScopedCard(store, id, ownerId, token);
        const result = await store.decompose(id, record, { ownerId, token: record.token });
        return jsonResult({
          parent: redactClaimToken(result.parent),
          children: result.children.map(redactClaimToken),
        });
      },
    },
    {
      name: "workboard_notify_subscribe",
      label: "Workboard Notify Subscribe",
      description: "Persist a Workboard notification subscription in the plugin SQLite store.",
      parameters: strictObject({
        boardId: Type.Optional(Type.String({ description: "Board id. Default default." })),
        cardId: Type.Optional(Type.String({ description: "Card id." })),
        sessionKey: Type.Optional(Type.String({ description: "Session key." })),
        runId: Type.Optional(Type.String({ description: "Run id." })),
        target: Type.Optional(Type.String({ description: "Human-readable target." })),
        eventKinds: Type.Optional(
          Type.Array(Type.String(), { description: "completed, failed, stale." }),
        ),
      }),
      execute: async (_toolCallId, rawParams) =>
        jsonResult({
          subscription: await store.subscribeNotifications(asNonArrayRecord(rawParams)),
        }),
    },
    {
      name: "workboard_notify_list",
      label: "Workboard Notify List",
      description: "List persisted Workboard notification subscriptions.",
      parameters: strictObject({
        boardId: Type.Optional(Type.String({ description: "Board id." })),
        cardId: Type.Optional(Type.String({ description: "Card id." })),
      }),
      execute: async (_toolCallId, rawParams) =>
        jsonResult(await store.listNotificationSubscriptions(asNonArrayRecord(rawParams))),
    },
    {
      name: "workboard_notify_events",
      label: "Workboard Notify Events",
      description: "Read replay-safe Workboard notification events without advancing cursors.",
      parameters: strictObject({
        subscriptionId: Type.Optional(Type.String({ description: "Subscription id." })),
        boardId: Type.Optional(Type.String({ description: "Board id." })),
        cardId: Type.Optional(Type.String({ description: "Card id." })),
        limit: Type.Optional(Type.Number({ description: "Maximum events. Default 50." })),
      }),
      execute: async (_toolCallId, rawParams) =>
        jsonResult(await store.notificationEvents(asNonArrayRecord(rawParams))),
    },
    {
      name: "workboard_notify_advance",
      label: "Workboard Notify Advance",
      description: "Read Workboard notification events and advance the subscription cursor.",
      parameters: strictObject({
        subscriptionId: Type.String({ description: "Subscription id." }),
        limit: Type.Optional(Type.Number({ description: "Maximum events. Default 50." })),
      }),
      execute: async (_toolCallId, rawParams) =>
        jsonResult(await store.advanceNotificationEvents(asNonArrayRecord(rawParams))),
    },
    {
      name: "workboard_notify_unsubscribe",
      label: "Workboard Notify Unsubscribe",
      description: "Delete a persisted Workboard notification subscription.",
      parameters: strictObject({ id: Type.String({ description: "Subscription id." }) }),
      execute: async (_toolCallId, rawParams) => {
        const id = readStringParam(asNonArrayRecord(rawParams), "id", { required: true });
        return jsonResult(await store.deleteNotificationSubscription(id));
      },
    },
    {
      name: "workboard_promote",
      label: "Workboard Promote",
      description:
        "Promote a dependency-ready card into ready, optionally forcing past holds for operator recovery.",
      parameters: strictObject({
        id: cardIdField(),
        token: ScopedClaimTokenField,
        force: Type.Optional(Type.Boolean({ description: "Bypass dependency or schedule holds." })),
        reason: OptionalOperatorNoteField,
      }),
      execute: async (_toolCallId, rawParams) => {
        return runScopedCardMutation(rawParams, (id, record, scope) =>
          store.promote(id, record, scope),
        );
      },
    },
    {
      name: "workboard_reassign",
      label: "Workboard Reassign",
      description: "Change a card assignee and optionally reset failure state during recovery.",
      parameters: strictObject({
        id: cardIdField(),
        token: ScopedClaimTokenField,
        agentId: Type.Optional(Type.String({ description: "New assignee id." })),
        status: OptionalNextStatusField,
        resetFailures: Type.Optional(Type.Boolean({ description: "Reset failure count." })),
        reason: OptionalOperatorNoteField,
      }),
      execute: async (_toolCallId, rawParams) => {
        return runScopedCardMutation(rawParams, (id, record, scope) =>
          store.reassign(id, record, scope),
        );
      },
    },
    {
      name: "workboard_reclaim",
      label: "Workboard Reclaim",
      description:
        "Release a stale claim and stop running attempts so another agent can pick it up.",
      parameters: strictObject({
        id: cardIdField(),
        token: ScopedClaimTokenField,
        status: OptionalNextStatusField,
        reason: OptionalOperatorNoteField,
      }),
      execute: async (_toolCallId, rawParams) => {
        return runScopedCardMutation(rawParams, (id, record, scope) =>
          store.reclaim(id, record, scope),
        );
      },
    },
    {
      name: "workboard_dispatch",
      label: "Workboard Dispatch",
      description:
        "Advance persisted board state without launching workers: promote unblocked cards, reclaim expired claims, and block timed-out runs.",
      parameters: strictObject({
        boardId: Type.Optional(Type.String({ description: "Optional board id filter." })),
      }),
      execute: async (_toolCallId, rawParams) => {
        const record = asNonArrayRecord(rawParams);
        const result = await store.dispatch({ boardId: record.boardId });
        return jsonResult({
          ...result,
          promoted: result.promoted.map(redactClaimToken),
          reclaimed: result.reclaimed.map(redactClaimToken),
          blocked: result.blocked.map(redactClaimToken),
          orchestrated: result.orchestrated.map(redactClaimToken),
        });
      },
    },
    {
      name: "workboard_worker_log",
      label: "Workboard Worker Log",
      description: "Append a persisted worker log entry to a Workboard card.",
      parameters: strictObject({
        id: cardIdField(),
        level: Type.Optional(Type.String({ description: "info, warning, or error." })),
        message: Type.String({ description: "Worker log message." }),
        sessionKey: Type.Optional(Type.String({ description: "Linked session key." })),
        runId: Type.Optional(Type.String({ description: "Linked run id." })),
        token: ScopedClaimTokenField,
      }),
      execute: async (_toolCallId, rawParams) => {
        const { record, id, scope } = await readScopedCardToolParams(rawParams);
        return redactedCardResult(await store.addWorkerLog(id, record, scope));
      },
    },
    {
      name: "workboard_protocol_violation",
      label: "Workboard Protocol Violation",
      description:
        "Block a card and record a worker protocol violation when work stops without complete/block.",
      parameters: strictObject({
        id: cardIdField(),
        detail: Type.Optional(Type.String({ description: "Violation detail." })),
        sessionKey: Type.Optional(Type.String({ description: "Linked session key." })),
        runId: Type.Optional(Type.String({ description: "Linked run id." })),
        token: ScopedClaimTokenField,
      }),
      execute: async (_toolCallId, rawParams) => {
        const { record, id, scope } = await readClaimedCardToolParams(rawParams);
        return redactedCardResult(await store.recordProtocolViolation(id, record, scope));
      },
    },
  ];
}
