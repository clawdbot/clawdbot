import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const actorRole = v.union(v.literal("ci"), v.literal("maintainer"));
const credentialStatus = v.union(v.literal("active"), v.literal("disabled"));
const leaseEventType = v.union(
  v.literal("acquire"),
  v.literal("acquire_failed"),
  v.literal("release"),
);
const adminEventType = v.union(v.literal("add"), v.literal("disable"), v.literal("disable_failed"));

export default defineSchema({
  credential_sets: defineTable({
    kind: v.string(),
    status: credentialStatus,
    payload: v.any(),
    createdAtMs: v.number(),
    updatedAtMs: v.number(),
    lastLeasedAtMs: v.number(),
    note: v.optional(v.string()),
    lease: v.optional(
      v.object({
        ownerId: v.string(),
        actorRole,
        leaseToken: v.string(),
        acquiredAtMs: v.number(),
        heartbeatAtMs: v.number(),
        expiresAtMs: v.number(),
      }),
    ),
  })
    .index("by_kind_status", ["kind", "status"])
    .index("by_kind_lastLeasedAtMs", ["kind", "lastLeasedAtMs"]),

  lease_events: defineTable({
    kind: v.string(),
    eventType: leaseEventType,
    actorRole,
    ownerId: v.string(),
    occurredAtMs: v.number(),
    credentialId: v.optional(v.id("credential_sets")),
    code: v.optional(v.string()),
    message: v.optional(v.string()),
  })
    .index("by_occurredAtMs", ["occurredAtMs"])
    .index("by_kind_occurredAtMs", ["kind", "occurredAtMs"])
    .index("by_credential_occurredAtMs", ["credentialId", "occurredAtMs"]),

  admin_events: defineTable({
    eventType: adminEventType,
    actorRole,
    actorId: v.string(),
    occurredAtMs: v.number(),
    credentialId: v.optional(v.id("credential_sets")),
    kind: v.optional(v.string()),
    code: v.optional(v.string()),
    message: v.optional(v.string()),
  })
    .index("by_occurredAtMs", ["occurredAtMs"])
    .index("by_kind_occurredAtMs", ["kind", "occurredAtMs"])
    .index("by_credential_occurredAtMs", ["credentialId", "occurredAtMs"]),
});
