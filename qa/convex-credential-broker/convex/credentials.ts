import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";

const LEASE_EVENT_RETENTION_MS = 2 * 24 * 60 * 60 * 1_000;
const ADMIN_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const EVENT_RETENTION_BATCH_SIZE = 256;
const MAX_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_LEASE_TTL_MS = 2 * 60 * 60 * 1_000;
const MIN_HEARTBEAT_INTERVAL_MS = 5_000;
const MIN_LEASE_TTL_MS = 30_000;
const MAX_LIST_LIMIT = 500;
const MIN_LIST_LIMIT = 1;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_LEASE_TTL_MS = 20 * 60 * 1_000;
const DEFAULT_LIST_LIMIT = 100;
const POOL_EXHAUSTED_RETRY_AFTER_MS = 2_000;

const actorRole = v.union(v.literal("ci"), v.literal("maintainer"));
const credentialStatus = v.union(v.literal("active"), v.literal("disabled"));
const listStatus = v.union(v.literal("active"), v.literal("disabled"), v.literal("all"));

type ActorRole = "ci" | "maintainer";
type CredentialStatus = "active" | "disabled";
type ListStatus = CredentialStatus | "all";
type LeaseEventType = "acquire" | "acquire_failed" | "release";
type AdminEventType = "add" | "disable" | "disable_failed";

type BrokerErrorResult = {
  status: "error";
  code: string;
  message: string;
  retryAfterMs?: number;
};

type BrokerOkResult = {
  status: "ok";
};

type CredentialLease = {
  ownerId: string;
  actorRole: ActorRole;
  leaseToken: string;
  acquiredAtMs: number;
  heartbeatAtMs: number;
  expiresAtMs: number;
};

type CredentialSetRecord = {
  _id: Id<"credential_sets">;
  kind: string;
  status: CredentialStatus;
  payload: unknown;
  createdAtMs: number;
  updatedAtMs: number;
  lastLeasedAtMs: number;
  note?: string;
  lease?: CredentialLease;
};

type EventInsertCtx = {
  db: {
    insert: (
      table: "lease_events" | "admin_events",
      value: Record<string, unknown>,
    ) => Promise<unknown>;
  };
};

function normalizeIntervalMs(params: {
  value: number | undefined;
  fallback: number;
  min: number;
  max: number;
}) {
  const value = params.value ?? params.fallback;
  const rounded = Math.floor(value);
  if (!Number.isFinite(rounded) || rounded < params.min || rounded > params.max) {
    return null;
  }
  return rounded;
}

function normalizeListLimit(value: number | undefined) {
  const limit = value ?? DEFAULT_LIST_LIMIT;
  const rounded = Math.floor(limit);
  if (!Number.isFinite(rounded) || rounded < MIN_LIST_LIMIT || rounded > MAX_LIST_LIMIT) {
    return null;
  }
  return rounded;
}

function brokerError(code: string, message: string, retryAfterMs?: number): BrokerErrorResult {
  return retryAfterMs && retryAfterMs > 0
    ? {
        status: "error",
        code,
        message,
        retryAfterMs,
      }
    : {
        status: "error",
        code,
        message,
      };
}

function leaseIsActive(lease: CredentialLease | undefined, nowMs: number) {
  return Boolean(lease && lease.expiresAtMs > nowMs);
}

function toCredentialSummary(row: CredentialSetRecord, includePayload: boolean) {
  return {
    credentialId: row._id,
    kind: row.kind,
    status: row.status,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    lastLeasedAtMs: row.lastLeasedAtMs,
    ...(row.note ? { note: row.note } : {}),
    ...(row.lease
      ? {
          lease: {
            ownerId: row.lease.ownerId,
            actorRole: row.lease.actorRole,
            acquiredAtMs: row.lease.acquiredAtMs,
            heartbeatAtMs: row.lease.heartbeatAtMs,
            expiresAtMs: row.lease.expiresAtMs,
          },
        }
      : {}),
    ...(includePayload ? { payload: row.payload } : {}),
  };
}

async function insertLeaseEvent(params: {
  ctx: EventInsertCtx;
  kind: string;
  eventType: LeaseEventType;
  actorRole: ActorRole;
  ownerId: string;
  occurredAtMs: number;
  credentialId?: Id<"credential_sets">;
  code?: string;
  message?: string;
}) {
  await params.ctx.db.insert("lease_events", {
    kind: params.kind,
    eventType: params.eventType,
    actorRole: params.actorRole,
    ownerId: params.ownerId,
    occurredAtMs: params.occurredAtMs,
    ...(params.credentialId ? { credentialId: params.credentialId } : {}),
    ...(params.code ? { code: params.code } : {}),
    ...(params.message ? { message: params.message } : {}),
  });
}

async function insertAdminEvent(params: {
  ctx: EventInsertCtx;
  eventType: AdminEventType;
  actorRole: ActorRole;
  actorId: string;
  occurredAtMs: number;
  credentialId?: Id<"credential_sets">;
  kind?: string;
  code?: string;
  message?: string;
}) {
  await params.ctx.db.insert("admin_events", {
    eventType: params.eventType,
    actorRole: params.actorRole,
    actorId: params.actorId,
    occurredAtMs: params.occurredAtMs,
    ...(params.credentialId ? { credentialId: params.credentialId } : {}),
    ...(params.kind ? { kind: params.kind } : {}),
    ...(params.code ? { code: params.code } : {}),
    ...(params.message ? { message: params.message } : {}),
  });
}

function sortByLeastRecentlyLeasedThenId(
  rows: Array<{
    _id: Id<"credential_sets">;
    lastLeasedAtMs: number;
  }>,
) {
  rows.sort((left, right) => {
    if (left.lastLeasedAtMs !== right.lastLeasedAtMs) {
      return left.lastLeasedAtMs - right.lastLeasedAtMs;
    }
    const leftId = String(left._id);
    const rightId = String(right._id);
    return leftId.localeCompare(rightId);
  });
}

function sortCredentialRowsForList(rows: CredentialSetRecord[]) {
  const statusRank: Record<CredentialStatus, number> = { active: 0, disabled: 1 };
  rows.sort((left, right) => {
    const kindCompare = left.kind.localeCompare(right.kind);
    if (kindCompare !== 0) {
      return kindCompare;
    }
    if (left.status !== right.status) {
      return statusRank[left.status] - statusRank[right.status];
    }
    if (left.updatedAtMs !== right.updatedAtMs) {
      return right.updatedAtMs - left.updatedAtMs;
    }
    return String(left._id).localeCompare(String(right._id));
  });
}

function normalizeActorId(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export const acquireLease = internalMutation({
  args: {
    kind: v.string(),
    ownerId: v.string(),
    actorRole,
    leaseTtlMs: v.optional(v.number()),
    heartbeatIntervalMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const nowMs = Date.now();
    const leaseTtlMs = normalizeIntervalMs({
      value: args.leaseTtlMs,
      fallback: DEFAULT_LEASE_TTL_MS,
      min: MIN_LEASE_TTL_MS,
      max: MAX_LEASE_TTL_MS,
    });
    if (!leaseTtlMs) {
      return brokerError(
        "INVALID_LEASE_TTL",
        `leaseTtlMs must be between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS}.`,
      );
    }
    const heartbeatIntervalMs = normalizeIntervalMs({
      value: args.heartbeatIntervalMs,
      fallback: DEFAULT_HEARTBEAT_INTERVAL_MS,
      min: MIN_HEARTBEAT_INTERVAL_MS,
      max: MAX_HEARTBEAT_INTERVAL_MS,
    });
    if (!heartbeatIntervalMs) {
      return brokerError(
        "INVALID_HEARTBEAT_INTERVAL",
        `heartbeatIntervalMs must be between ${MIN_HEARTBEAT_INTERVAL_MS} and ${MAX_HEARTBEAT_INTERVAL_MS}.`,
      );
    }

    const activeRows = (await ctx.db
      .query("credential_sets")
      .withIndex("by_kind_status", (q) => q.eq("kind", args.kind).eq("status", "active"))
      .collect()) as CredentialSetRecord[];

    const availableRows = activeRows.filter((row) => !leaseIsActive(row.lease, nowMs));

    if (availableRows.length === 0) {
      await insertLeaseEvent({
        ctx,
        kind: args.kind,
        eventType: "acquire_failed",
        actorRole: args.actorRole,
        ownerId: args.ownerId,
        occurredAtMs: nowMs,
        code: "POOL_EXHAUSTED",
        message: "No active credential in this kind is currently available.",
      });
      return brokerError(
        "POOL_EXHAUSTED",
        `No available credential for kind "${args.kind}".`,
        POOL_EXHAUSTED_RETRY_AFTER_MS,
      );
    }

    sortByLeastRecentlyLeasedThenId(availableRows);
    const selected = availableRows[0];
    const leaseToken = crypto.randomUUID();

    await ctx.db.patch(selected._id, {
      lease: {
        ownerId: args.ownerId,
        actorRole: args.actorRole,
        leaseToken,
        acquiredAtMs: nowMs,
        heartbeatAtMs: nowMs,
        expiresAtMs: nowMs + leaseTtlMs,
      },
      lastLeasedAtMs: nowMs,
      updatedAtMs: nowMs,
    });

    await insertLeaseEvent({
      ctx,
      kind: args.kind,
      eventType: "acquire",
      actorRole: args.actorRole,
      ownerId: args.ownerId,
      occurredAtMs: nowMs,
      credentialId: selected._id,
    });

    return {
      status: "ok",
      credentialId: selected._id,
      leaseToken,
      payload: selected.payload,
      leaseTtlMs,
      heartbeatIntervalMs,
    };
  },
});

export const heartbeatLease = internalMutation({
  args: {
    kind: v.string(),
    ownerId: v.string(),
    actorRole,
    credentialId: v.id("credential_sets"),
    leaseToken: v.string(),
    leaseTtlMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<BrokerErrorResult | BrokerOkResult> => {
    const nowMs = Date.now();
    const leaseTtlMs = normalizeIntervalMs({
      value: args.leaseTtlMs,
      fallback: DEFAULT_LEASE_TTL_MS,
      min: MIN_LEASE_TTL_MS,
      max: MAX_LEASE_TTL_MS,
    });
    if (!leaseTtlMs) {
      return brokerError(
        "INVALID_LEASE_TTL",
        `leaseTtlMs must be between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS}.`,
      );
    }

    const row = (await ctx.db.get(args.credentialId)) as CredentialSetRecord | null;
    if (!row) {
      return brokerError("CREDENTIAL_NOT_FOUND", "Credential record does not exist.");
    }
    if (row.kind !== args.kind) {
      return brokerError("KIND_MISMATCH", "Credential kind did not match this lease heartbeat.");
    }
    if (row.status !== "active") {
      return brokerError(
        "CREDENTIAL_DISABLED",
        "Credential is disabled and cannot be heartbeated.",
      );
    }
    if (!row.lease) {
      return brokerError("LEASE_NOT_FOUND", "Credential is not currently leased.");
    }
    if (row.lease.ownerId !== args.ownerId || row.lease.leaseToken !== args.leaseToken) {
      return brokerError("LEASE_NOT_OWNER", "Credential lease owner/token mismatch.");
    }
    if (row.lease.expiresAtMs < nowMs) {
      return brokerError("LEASE_EXPIRED", "Credential lease has already expired.");
    }

    await ctx.db.patch(args.credentialId, {
      lease: {
        ...row.lease,
        heartbeatAtMs: nowMs,
        expiresAtMs: nowMs + leaseTtlMs,
      },
      updatedAtMs: nowMs,
    });

    return { status: "ok" };
  },
});

export const releaseLease = internalMutation({
  args: {
    kind: v.string(),
    ownerId: v.string(),
    actorRole,
    credentialId: v.id("credential_sets"),
    leaseToken: v.string(),
  },
  handler: async (ctx, args): Promise<BrokerErrorResult | BrokerOkResult> => {
    const nowMs = Date.now();
    const row = (await ctx.db.get(args.credentialId)) as CredentialSetRecord | null;
    if (!row) {
      return brokerError("CREDENTIAL_NOT_FOUND", "Credential record does not exist.");
    }
    if (row.kind !== args.kind) {
      return brokerError("KIND_MISMATCH", "Credential kind did not match this lease release.");
    }
    if (!row.lease) {
      return { status: "ok" };
    }
    if (row.lease.ownerId !== args.ownerId || row.lease.leaseToken !== args.leaseToken) {
      return brokerError("LEASE_NOT_OWNER", "Credential lease owner/token mismatch.");
    }

    await ctx.db.patch(args.credentialId, {
      lease: undefined,
      updatedAtMs: nowMs,
    });
    await insertLeaseEvent({
      ctx,
      kind: args.kind,
      eventType: "release",
      actorRole: args.actorRole,
      ownerId: args.ownerId,
      occurredAtMs: nowMs,
      credentialId: args.credentialId,
    });
    return { status: "ok" };
  },
});

export const addCredentialSet = internalMutation({
  args: {
    kind: v.string(),
    payload: v.any(),
    note: v.optional(v.string()),
    actorId: v.optional(v.string()),
    status: v.optional(credentialStatus),
  },
  handler: async (ctx, args) => {
    const nowMs = Date.now();
    const actorId = normalizeActorId(args.actorId);
    const status = args.status ?? "active";
    const note = args.note?.trim();
    const credentialId = await ctx.db.insert("credential_sets", {
      kind: args.kind,
      status,
      payload: args.payload,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      lastLeasedAtMs: 0,
      ...(note ? { note } : {}),
    });

    await insertAdminEvent({
      ctx,
      eventType: "add",
      actorRole: "maintainer",
      actorId,
      occurredAtMs: nowMs,
      credentialId,
      kind: args.kind,
    });

    const created: CredentialSetRecord = {
      _id: credentialId,
      kind: args.kind,
      status,
      payload: args.payload,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      lastLeasedAtMs: 0,
      ...(note ? { note } : {}),
    };
    return {
      status: "ok",
      credential: toCredentialSummary(created, false),
    };
  },
});

export const disableCredentialSet = internalMutation({
  args: {
    credentialId: v.id("credential_sets"),
    actorId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const nowMs = Date.now();
    const actorId = normalizeActorId(args.actorId);
    const row = (await ctx.db.get(args.credentialId)) as CredentialSetRecord | null;
    if (!row) {
      await insertAdminEvent({
        ctx,
        eventType: "disable_failed",
        actorRole: "maintainer",
        actorId,
        occurredAtMs: nowMs,
        credentialId: args.credentialId,
        code: "CREDENTIAL_NOT_FOUND",
        message: "Credential record does not exist.",
      });
      return brokerError("CREDENTIAL_NOT_FOUND", "Credential record does not exist.");
    }
    if (leaseIsActive(row.lease, nowMs)) {
      await insertAdminEvent({
        ctx,
        eventType: "disable_failed",
        actorRole: "maintainer",
        actorId,
        occurredAtMs: nowMs,
        credentialId: row._id,
        kind: row.kind,
        code: "LEASE_ACTIVE",
        message: "Credential is currently leased and cannot be disabled yet.",
      });
      return brokerError("LEASE_ACTIVE", "Credential is currently leased and cannot be disabled.");
    }
    if (row.status === "disabled") {
      return {
        status: "ok",
        changed: false,
        credential: toCredentialSummary(row, false),
      };
    }

    await ctx.db.patch(args.credentialId, {
      status: "disabled",
      lease: undefined,
      updatedAtMs: nowMs,
    });

    await insertAdminEvent({
      ctx,
      eventType: "disable",
      actorRole: "maintainer",
      actorId,
      occurredAtMs: nowMs,
      credentialId: row._id,
      kind: row.kind,
    });

    const updated: CredentialSetRecord = {
      ...row,
      status: "disabled",
      lease: undefined,
      updatedAtMs: nowMs,
    };
    return {
      status: "ok",
      changed: true,
      credential: toCredentialSummary(updated, false),
    };
  },
});

export const listCredentialSets = internalQuery({
  args: {
    kind: v.optional(v.string()),
    status: v.optional(listStatus),
    includePayload: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const normalizedStatus: ListStatus = args.status ?? "all";
    const includePayload = args.includePayload === true;
    const limit = normalizeListLimit(args.limit);
    if (!limit) {
      return brokerError(
        "INVALID_LIST_LIMIT",
        `limit must be between ${MIN_LIST_LIMIT} and ${MAX_LIST_LIMIT}.`,
      );
    }

    let rows: CredentialSetRecord[] = [];
    const kind = args.kind?.trim();
    if (kind) {
      if (normalizedStatus === "all") {
        rows = (await ctx.db
          .query("credential_sets")
          .withIndex("by_kind_lastLeasedAtMs", (q) => q.eq("kind", kind))
          .collect()) as CredentialSetRecord[];
      } else {
        rows = (await ctx.db
          .query("credential_sets")
          .withIndex("by_kind_status", (q) => q.eq("kind", kind).eq("status", normalizedStatus))
          .collect()) as CredentialSetRecord[];
      }
    } else {
      rows = (await ctx.db.query("credential_sets").collect()) as CredentialSetRecord[];
      if (normalizedStatus !== "all") {
        rows = rows.filter((row) => row.status === normalizedStatus);
      }
    }

    sortCredentialRowsForList(rows);
    const selected = rows.slice(0, limit);
    return {
      status: "ok",
      credentials: selected.map((row) => toCredentialSummary(row, includePayload)),
      count: selected.length,
    };
  },
});

export const cleanupLeaseEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoffMs = Date.now() - LEASE_EVENT_RETENTION_MS;
    const staleRows = await ctx.db
      .query("lease_events")
      .withIndex("by_occurredAtMs", (q) => q.lt("occurredAtMs", cutoffMs))
      .take(EVENT_RETENTION_BATCH_SIZE);

    for (const row of staleRows) {
      await ctx.db.delete(row._id);
    }

    if (staleRows.length === EVENT_RETENTION_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.credentials.cleanupLeaseEvents, {});
    }

    return {
      status: "ok",
      deleted: staleRows.length,
      retentionMs: LEASE_EVENT_RETENTION_MS,
    };
  },
});

export const cleanupAdminEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoffMs = Date.now() - ADMIN_EVENT_RETENTION_MS;
    const staleRows = await ctx.db
      .query("admin_events")
      .withIndex("by_occurredAtMs", (q) => q.lt("occurredAtMs", cutoffMs))
      .take(EVENT_RETENTION_BATCH_SIZE);

    for (const row of staleRows) {
      await ctx.db.delete(row._id);
    }

    if (staleRows.length === EVENT_RETENTION_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.credentials.cleanupAdminEvents, {});
    }

    return {
      status: "ok",
      deleted: staleRows.length,
      retentionMs: ADMIN_EVENT_RETENTION_MS,
    };
  },
});
