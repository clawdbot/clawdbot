import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { parseJson } from "./store-sqlite-record.js";
import {
  openSkillWorkshopStore,
  type SkillWorkshopDatabase,
  type SkillWorkshopStoreOptions,
} from "./store-sqlite-schema.js";
import type {
  SkillProposalEvent,
  SkillProposalEventActor,
  SkillProposalEventsListInput,
  SkillProposalEventsListResult,
  SkillProposalEventType,
} from "./types.js";

export type NewSkillProposalEvent = Omit<SkillProposalEvent, "sequence">;

export function appendSkillProposalEvent(
  database: DatabaseSync,
  event: NewSkillProposalEvent,
): SkillProposalEvent {
  const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(database);
  const inserted = executeSqliteQueryTakeFirstSync(
    database,
    kysely
      .insertInto("skill_workshop_proposal_events")
      .values({
        event_id: event.eventId,
        proposal_id: event.proposalId,
        proposed_version: event.proposedVersion,
        revision_hash: event.revisionHash,
        event_type: event.type,
        occurred_at: event.occurredAt,
        actor_json: JSON.stringify(event.actor),
        correlation_id: event.correlationId ?? null,
        payload_json: event.payload ? JSON.stringify(event.payload) : null,
      })
      .returning("sequence"),
  );
  if (!inserted) {
    throw new Error(`Failed to append Skill Workshop event: ${event.eventId}`);
  }
  return { ...event, sequence: inserted.sequence };
}

export function listStoredSkillProposalEvents(
  input: SkillProposalEventsListInput,
  options: SkillWorkshopStoreOptions = {},
): SkillProposalEventsListResult {
  const { database, kysely } = openSkillWorkshopStore(options);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
  let query = kysely
    .selectFrom("skill_workshop_proposal_events")
    .innerJoin(
      "skill_workshop_proposals",
      "skill_workshop_proposals.proposal_id",
      "skill_workshop_proposal_events.proposal_id",
    )
    .select([
      "skill_workshop_proposal_events.sequence",
      "skill_workshop_proposal_events.event_id",
      "skill_workshop_proposal_events.proposal_id",
      "skill_workshop_proposal_events.proposed_version",
      "skill_workshop_proposal_events.revision_hash",
      "skill_workshop_proposal_events.event_type",
      "skill_workshop_proposal_events.occurred_at",
      "skill_workshop_proposal_events.actor_json",
      "skill_workshop_proposal_events.correlation_id",
      "skill_workshop_proposal_events.payload_json",
    ])
    .where("skill_workshop_proposal_events.sequence", ">", input.afterSequence ?? 0);
  if (input.proposalId) {
    query = query.where("skill_workshop_proposal_events.proposal_id", "=", input.proposalId);
  }
  if (input.agentId) {
    query = query.where((eb) =>
      eb.or([
        eb("skill_workshop_proposals.owner_agent_id", "=", input.agentId!),
        ...(input.workspaceDir
          ? [
              eb.and([
                eb("skill_workshop_proposals.owner_agent_id", "is", null),
                eb("skill_workshop_proposals.workspace_dir", "=", path.resolve(input.workspaceDir)),
              ]),
            ]
          : []),
      ]),
    );
  } else if (input.workspaceDir) {
    query = query.where(
      "skill_workshop_proposals.workspace_dir",
      "=",
      path.resolve(input.workspaceDir),
    );
  }
  const rows = executeSqliteQuerySync(
    database.db,
    query.orderBy("skill_workshop_proposal_events.sequence", "asc").limit(limit + 1),
  ).rows;
  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit).flatMap((row) => {
    const actor = parseSkillProposalEventActor(parseJson(row.actor_json));
    const payload = parseSkillProposalEventPayload(parseJson(row.payload_json));
    if (!actor || !isSkillProposalEventType(row.event_type)) {
      return [];
    }
    return [
      {
        sequence: row.sequence,
        eventId: row.event_id,
        proposalId: row.proposal_id,
        proposedVersion: row.proposed_version,
        revisionHash: row.revision_hash,
        type: row.event_type,
        occurredAt: row.occurred_at,
        actor,
        ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
        ...(payload ? { payload } : {}),
      },
    ];
  });
  return {
    events,
    ...(hasMore && events.length > 0 ? { nextSequence: events[events.length - 1]!.sequence } : {}),
  };
}

function isSkillProposalEventType(value: string): value is SkillProposalEventType {
  return [
    "created",
    "revised",
    "evaluation_completed",
    "applied",
    "rejected",
    "quarantined",
    "stale",
  ].includes(value);
}

function parseSkillProposalEventActor(value: unknown): SkillProposalEventActor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const actor = value as SkillProposalEventActor;
  if (
    !["agent", "gateway", "plugin", "system"].includes(actor.type) ||
    (actor.id !== undefined && typeof actor.id !== "string")
  ) {
    return null;
  }
  return actor;
}

function parseSkillProposalEventPayload(
  value: unknown,
): Record<string, string | number | boolean | null> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (
    entries.length > 32 ||
    entries.some(
      ([key, item]) =>
        !key ||
        key.length > 80 ||
        (item !== null &&
          typeof item !== "string" &&
          typeof item !== "number" &&
          typeof item !== "boolean"),
    )
  ) {
    return undefined;
  }
  return Object.fromEntries(entries);
}
