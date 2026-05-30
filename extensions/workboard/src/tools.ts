import { jsonResult, readStringParam } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { WorkboardStore, type PersistedWorkboardCard } from "./store.js";
import type { WorkboardCard } from "./types.js";

function contextOwner(ctx: OpenClawPluginToolContext | undefined): string {
  const record = (ctx ?? {}) as Record<string, unknown>;
  return (
    (typeof record.agentId === "string" && record.agentId) ||
    (typeof record.sessionKey === "string" && record.sessionKey) ||
    (typeof record.sessionId === "string" && record.sessionId) ||
    "agent"
  );
}

function canMutateCard(card: WorkboardCard, ownerId: string, token?: string): boolean {
  const claim = card.metadata?.claim;
  if (!claim) {
    return true;
  }
  return claim.ownerId === ownerId || (Boolean(token) && claim.token === token);
}

function readParentIds(value: unknown): string[] {
  if (value == null) {
    return [];
  }
  const entries =
    typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : undefined;
  if (!entries) {
    throw new Error("parents must be an array or comma-separated string.");
  }
  const parents: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      throw new Error("parents must contain only strings.");
    }
    const parent = entry.trim();
    if (!parent || parents.includes(parent)) {
      continue;
    }
    if (parent.length > 120) {
      throw new Error("parents must be 120 characters or fewer.");
    }
    parents.push(parent);
    if (parents.length >= 20) {
      break;
    }
  }
  return parents;
}

async function requireScopedCard(
  store: WorkboardStore,
  cardId: string,
  ownerId: string,
  token?: string,
): Promise<WorkboardCard> {
  const card = await store.get(cardId);
  if (!card) {
    throw new Error(`card not found: ${cardId}`);
  }
  if (!canMutateCard(card, ownerId, token)) {
    throw new Error(`card is claimed by ${card.metadata?.claim?.ownerId ?? "another agent"}.`);
  }
  return card;
}

async function requireClaimedCard(
  store: WorkboardStore,
  cardId: string,
  ownerId: string,
  token?: string,
): Promise<WorkboardCard> {
  const card = await requireScopedCard(store, cardId, ownerId, token);
  if (!card.metadata?.claim) {
    throw new Error("card must be claimed before lifecycle completion.");
  }
  return card;
}

function summarizeCard(card: WorkboardCard) {
  return {
    id: card.id,
    title: card.title,
    status: card.status,
    priority: card.priority,
    agentId: card.agentId,
    tenant: card.metadata?.automation?.tenant,
    boardId: card.metadata?.automation?.boardId ?? "default",
    parents: card.metadata?.links
      ?.filter((link) => link.type === "parent" && link.targetCardId)
      .map((link) => link.targetCardId),
    children: card.metadata?.links
      ?.filter((link) => link.type === "child" && link.targetCardId)
      .map((link) => link.targetCardId),
    claim: card.metadata?.claim
      ? {
          ownerId: card.metadata.claim.ownerId,
          claimedAt: card.metadata.claim.claimedAt,
          lastHeartbeatAt: card.metadata.claim.lastHeartbeatAt,
          expiresAt: card.metadata.claim.expiresAt,
        }
      : undefined,
    diagnostics: card.metadata?.diagnostics,
    archivedAt: card.metadata?.archivedAt,
    updatedAt: card.updatedAt,
  };
}

function redactClaimToken(card: WorkboardCard): WorkboardCard {
  const claim = card.metadata?.claim;
  if (!claim) {
    return card;
  }
  return {
    ...card,
    metadata: {
      ...card.metadata,
      claim: {
        ...claim,
        token: "[redacted]",
      },
    },
  };
}

const CardIdSchema = Type.Object(
  {
    id: Type.String({ description: "Workboard card id." }),
    token: Type.Optional(Type.String({ description: "Claim token returned by workboard_claim." })),
  },
  { additionalProperties: false },
);

export function createWorkboardTools(params: {
  api: OpenClawPluginApi;
  context?: OpenClawPluginToolContext;
  store?: WorkboardStore;
}): AnyAgentTool[] {
  const store =
    params.store ??
    WorkboardStore.open((options) =>
      params.api.runtime.state.openKeyedStore<PersistedWorkboardCard>(options),
    );
  const ownerId = contextOwner(params.context);
  return [
    {
      name: "workboard_list",
      label: "Workboard List",
      description:
        "List Workboard cards with compact claim and diagnostic state. Use before choosing or routing board work.",
      parameters: Type.Object(
        {
          status: Type.Optional(Type.String({ description: "Optional card status filter." })),
          agentId: Type.Optional(Type.String({ description: "Optional agent id filter." })),
          tenant: Type.Optional(Type.String({ description: "Optional tenant filter." })),
          boardId: Type.Optional(Type.String({ description: "Optional board id filter." })),
          limit: Type.Optional(
            Type.Number({ description: "Maximum cards to return. Default 50." }),
          ),
          refreshDiagnostics: Type.Optional(
            Type.Boolean({ description: "Refresh stored diagnostics before listing." }),
          ),
          includeArchived: Type.Optional(
            Type.Boolean({ description: "Include archived cards. Default false." }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        if (record.refreshDiagnostics === true) {
          await store.refreshDiagnostics();
        }
        const status = typeof record.status === "string" ? record.status : undefined;
        const agentId = typeof record.agentId === "string" ? record.agentId : undefined;
        const tenant = typeof record.tenant === "string" ? record.tenant : undefined;
        const boardId = typeof record.boardId === "string" ? record.boardId : undefined;
        const limit =
          typeof record.limit === "number" && Number.isFinite(record.limit)
            ? Math.max(1, Math.min(200, Math.trunc(record.limit)))
            : 50;
        const cards = (await store.list({ boardId }))
          .filter((card) => record.includeArchived === true || !card.metadata?.archivedAt)
          .filter((card) => !status || card.status === status)
          .filter((card) => !agentId || card.agentId === agentId)
          .filter((card) => !tenant || card.metadata?.automation?.tenant === tenant)
          .slice(0, limit)
          .map(summarizeCard);
        return jsonResult({ cards });
      },
    },
    {
      name: "workboard_create",
      label: "Workboard Create",
      description:
        "Create a Workboard card, optionally with parent dependencies, tenant, skills, workspace, and idempotency key.",
      parameters: Type.Object(
        {
          title: Type.String({ description: "Card title." }),
          notes: Type.Optional(Type.String({ description: "Card notes or acceptance criteria." })),
          status: Type.Optional(Type.String({ description: "Initial status." })),
          priority: Type.Optional(Type.String({ description: "low, normal, high, or urgent." })),
          labels: Type.Optional(Type.Array(Type.String(), { description: "Card labels." })),
          agentId: Type.Optional(Type.String({ description: "Assigned agent id." })),
          parents: Type.Optional(Type.Array(Type.String(), { description: "Parent card ids." })),
          token: Type.Optional(
            Type.String({ description: "Claim token for claimed parent cards." }),
          ),
          tenant: Type.Optional(Type.String({ description: "Soft tenant namespace." })),
          boardId: Type.Optional(Type.String({ description: "Soft board namespace." })),
          createdByCardId: Type.Optional(
            Type.String({ description: "Parent card that created this card." }),
          ),
          idempotencyKey: Type.Optional(Type.String({ description: "Idempotent create key." })),
          skills: Type.Optional(Type.Array(Type.String(), { description: "Suggested skills." })),
          workspace: Type.Optional(
            Type.Object(
              {
                kind: Type.String({ description: "scratch, dir, or worktree." }),
                path: Type.Optional(Type.String({ description: "Absolute dir/worktree path." })),
                branch: Type.Optional(Type.String({ description: "Suggested branch." })),
              },
              { additionalProperties: false },
            ),
          ),
          maxRuntimeSeconds: Type.Optional(Type.Number({ description: "Run timeout seconds." })),
          maxRetries: Type.Optional(Type.Number({ description: "Retry budget." })),
          scheduledAt: Type.Optional(Type.Number({ description: "Unix epoch milliseconds." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        readParentIds(record.parents);
        return jsonResult({
          card: redactClaimToken(
            await store.create(record, { ownerId, token: record.token as string | undefined }),
          ),
        });
      },
    },
    {
      name: "workboard_link",
      label: "Workboard Link",
      description:
        "Link a parent card to a child card so the child becomes ready only after parents are done.",
      parameters: Type.Object(
        {
          parentId: Type.String({ description: "Parent card id." }),
          childId: Type.String({ description: "Child card id." }),
          token: Type.Optional(
            Type.String({ description: "Claim token for claimed parent or child cards." }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const parentId = readStringParam(record, "parentId", { required: true });
        const childId = readStringParam(record, "childId", { required: true });
        const token = record.token as string | undefined;
        return jsonResult({
          card: redactClaimToken(await store.linkCards(parentId, childId, { ownerId, token })),
        });
      },
    },
    {
      name: "workboard_read",
      label: "Workboard Read",
      description:
        "Read one Workboard card and return bounded worker context with notes, attempts, comments, proof, links, and diagnostics.",
      parameters: CardIdSchema,
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        const card = await store.get(id);
        if (!card) {
          throw new Error(`card not found: ${id}`);
        }
        return jsonResult({
          card: redactClaimToken(card),
          workerContext: await store.buildWorkerContext(id),
        });
      },
    },
    {
      name: "workboard_claim",
      label: "Workboard Claim",
      description:
        "Claim a Workboard card for this agent and move backlog/todo cards into running. Returns a claim token for heartbeats and release.",
      parameters: Type.Object(
        {
          id: Type.String({ description: "Workboard card id." }),
          ttlSeconds: Type.Optional(Type.Number({ description: "Claim TTL in seconds." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        const claimed = await store.claim(id, {
          ownerId,
          ttlSeconds: record.ttlSeconds,
        });
        return jsonResult({ ...claimed, card: redactClaimToken(claimed.card) });
      },
    },
    {
      name: "workboard_heartbeat",
      label: "Workboard Heartbeat",
      description:
        "Refresh this agent's Workboard claim heartbeat. Use during long-running card work so diagnostics do not mark it stale.",
      parameters: Type.Object(
        {
          id: Type.String({ description: "Workboard card id." }),
          token: Type.Optional(
            Type.String({ description: "Claim token returned by workboard_claim." }),
          ),
          note: Type.Optional(Type.String({ description: "Optional compact progress note." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        await requireScopedCard(store, id, ownerId, record.token as string | undefined);
        return jsonResult(
          redactClaimToken(
            await store.heartbeat(id, {
              ownerId,
              token: record.token,
              note: record.note,
            }),
          ),
        );
      },
    },
    {
      name: "workboard_release",
      label: "Workboard Release",
      description:
        "Release this agent's Workboard claim after finishing, pausing, or handing off card work.",
      parameters: Type.Object(
        {
          id: Type.String({ description: "Workboard card id." }),
          token: Type.Optional(
            Type.String({ description: "Claim token returned by workboard_claim." }),
          ),
          status: Type.Optional(
            Type.String({ description: "Optional next card status after release." }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        await requireScopedCard(store, id, ownerId, record.token as string | undefined);
        return jsonResult(
          redactClaimToken(
            await store.releaseClaim(id, {
              ownerId,
              token: record.token,
              status: record.status,
            }),
          ),
        );
      },
    },
    {
      name: "workboard_comment",
      label: "Workboard Comment",
      description: "Append a compact comment to a Workboard card.",
      parameters: Type.Object(
        {
          id: Type.String({ description: "Workboard card id." }),
          body: Type.String({ description: "Comment body." }),
          token: Type.Optional(Type.String({ description: "Claim token for claimed cards." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        await requireScopedCard(store, id, ownerId, record.token as string | undefined);
        return jsonResult(
          redactClaimToken(
            await store.addComment(id, { body: record.body }, { ownerId, token: record.token }),
          ),
        );
      },
    },
    {
      name: "workboard_proof",
      label: "Workboard Proof",
      description:
        "Attach proof or artifact metadata to a Workboard card after running tests, checks, or producing screenshots/logs.",
      parameters: Type.Object(
        {
          id: Type.String({ description: "Workboard card id." }),
          status: Type.Optional(
            Type.String({ description: "passed, failed, skipped, or unknown." }),
          ),
          label: Type.Optional(Type.String({ description: "Proof label." })),
          command: Type.Optional(Type.String({ description: "Command or exact step run." })),
          url: Type.Optional(Type.String({ description: "Proof or artifact URL." })),
          note: Type.Optional(Type.String({ description: "Short proof note." })),
          artifactPath: Type.Optional(
            Type.String({ description: "Optional local artifact path." }),
          ),
          token: Type.Optional(Type.String({ description: "Claim token for claimed cards." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        await requireScopedCard(store, id, ownerId, record.token as string | undefined);
        const scope = { ownerId, token: record.token };
        const hasArtifact =
          (typeof record.artifactPath === "string" && record.artifactPath.trim() !== "") ||
          (typeof record.url === "string" && record.url.trim() !== "");
        const card = hasArtifact
          ? await store.addProofWithArtifact(
              id,
              record,
              {
                label: record.label,
                path: record.artifactPath,
                url: record.url,
              },
              scope,
            )
          : await store.addProof(id, record, scope);
        return jsonResult({ card: redactClaimToken(card) });
      },
    },
    {
      name: "workboard_complete",
      label: "Workboard Complete",
      description:
        "Complete a claimed Workboard card with a structured summary, proof, artifacts, and created-card manifest.",
      parameters: Type.Object(
        {
          id: Type.String({ description: "Workboard card id." }),
          token: Type.Optional(
            Type.String({ description: "Claim token returned by workboard_claim." }),
          ),
          summary: Type.Optional(Type.String({ description: "Completion summary." })),
          proof: Type.Optional(
            Type.Object(
              {
                status: Type.Optional(
                  Type.String({ description: "passed, failed, skipped, or unknown." }),
                ),
                label: Type.Optional(Type.String({ description: "Proof label." })),
                command: Type.Optional(Type.String({ description: "Command or step run." })),
                url: Type.Optional(Type.String({ description: "Proof URL." })),
                note: Type.Optional(Type.String({ description: "Proof note." })),
              },
              { additionalProperties: false },
            ),
          ),
          artifacts: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  label: Type.Optional(Type.String()),
                  url: Type.Optional(Type.String()),
                  path: Type.Optional(Type.String()),
                  mimeType: Type.Optional(Type.String()),
                },
                { additionalProperties: false },
              ),
            ),
          ),
          createdCardIds: Type.Optional(
            Type.Array(Type.String(), { description: "Cards created during this run." }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        const scope = { ownerId, token: record.token };
        await requireClaimedCard(store, id, ownerId, record.token as string | undefined);
        return jsonResult({
          card: redactClaimToken(await store.complete(id, record, scope)),
        });
      },
    },
    {
      name: "workboard_block",
      label: "Workboard Block",
      description: "Block a claimed Workboard card with a durable reason and release the claim.",
      parameters: Type.Object(
        {
          id: Type.String({ description: "Workboard card id." }),
          token: Type.Optional(
            Type.String({ description: "Claim token returned by workboard_claim." }),
          ),
          reason: Type.Optional(Type.String({ description: "Blocker summary." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        const scope = { ownerId, token: record.token };
        await requireClaimedCard(store, id, ownerId, record.token as string | undefined);
        return jsonResult({
          card: redactClaimToken(await store.block(id, record, scope)),
        });
      },
    },
    {
      name: "workboard_unblock",
      label: "Workboard Unblock",
      description: "Move a blocked Workboard card back to todo after adding enough context.",
      parameters: CardIdSchema,
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        await requireScopedCard(store, id, ownerId, record.token as string | undefined);
        return jsonResult(
          redactClaimToken(await store.unblock(id, { ownerId, token: record.token })),
        );
      },
    },
    {
      name: "workboard_boards",
      label: "Workboard Boards",
      description: "List Workboard board namespaces with active, archived, and status counts.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => jsonResult(await store.listBoards()),
    },
    {
      name: "workboard_stats",
      label: "Workboard Stats",
      description: "Summarize Workboard counts by status and assignee for one board or all boards.",
      parameters: Type.Object(
        {
          boardId: Type.Optional(Type.String({ description: "Optional board id filter." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        return jsonResult(await store.stats({ boardId: record.boardId }));
      },
    },
    {
      name: "workboard_promote",
      label: "Workboard Promote",
      description:
        "Promote a dependency-ready card into ready, optionally forcing past holds for operator recovery.",
      parameters: Type.Object(
        {
          id: Type.String({ description: "Workboard card id." }),
          token: Type.Optional(Type.String({ description: "Claim token for claimed cards." })),
          force: Type.Optional(
            Type.Boolean({ description: "Bypass dependency or schedule holds." }),
          ),
          reason: Type.Optional(Type.String({ description: "Optional operator note." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        await requireScopedCard(store, id, ownerId, record.token as string | undefined);
        return jsonResult({
          card: redactClaimToken(await store.promote(id, record, { ownerId, token: record.token })),
        });
      },
    },
    {
      name: "workboard_reassign",
      label: "Workboard Reassign",
      description: "Change a card assignee and optionally reset failure state during recovery.",
      parameters: Type.Object(
        {
          id: Type.String({ description: "Workboard card id." }),
          token: Type.Optional(Type.String({ description: "Claim token for claimed cards." })),
          agentId: Type.Optional(Type.String({ description: "New assignee id." })),
          status: Type.Optional(Type.String({ description: "Optional next status." })),
          resetFailures: Type.Optional(Type.Boolean({ description: "Reset failure count." })),
          reason: Type.Optional(Type.String({ description: "Optional operator note." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        await requireScopedCard(store, id, ownerId, record.token as string | undefined);
        return jsonResult({
          card: redactClaimToken(
            await store.reassign(id, record, { ownerId, token: record.token }),
          ),
        });
      },
    },
    {
      name: "workboard_reclaim",
      label: "Workboard Reclaim",
      description:
        "Release a stale claim and stop running attempts so another agent can pick it up.",
      parameters: Type.Object(
        {
          id: Type.String({ description: "Workboard card id." }),
          token: Type.Optional(Type.String({ description: "Claim token for claimed cards." })),
          status: Type.Optional(Type.String({ description: "Optional next status." })),
          reason: Type.Optional(Type.String({ description: "Optional operator note." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const record = rawParams as Record<string, unknown>;
        const id = readStringParam(record, "id", { required: true });
        await requireScopedCard(store, id, ownerId, record.token as string | undefined);
        return jsonResult({
          card: redactClaimToken(await store.reclaim(id, record, { ownerId, token: record.token })),
        });
      },
    },
    {
      name: "workboard_dispatch",
      label: "Workboard Dispatch",
      description:
        "Nudge Workboard dependency promotion and reclaim expired claims or timed-out runs.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        const result = await store.dispatch();
        return jsonResult({
          ...result,
          promoted: result.promoted.map(redactClaimToken),
          reclaimed: result.reclaimed.map(redactClaimToken),
          blocked: result.blocked.map(redactClaimToken),
        });
      },
    },
  ];
}
