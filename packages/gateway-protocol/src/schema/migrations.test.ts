// Gateway Protocol tests cover memory migration request boundaries.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  MigrationsMemoryApplyParamsSchema,
  MigrationsMemoryPlanParamsSchema,
} from "./migrations.js";

describe("memory migration schemas", () => {
  it("accepts a scoped plan request and rejects unknown fields", () => {
    expect(
      Value.Check(MigrationsMemoryPlanParamsSchema, {
        agentId: "research",
        overwrite: true,
      }),
    ).toBe(true);
    expect(
      Value.Check(MigrationsMemoryPlanParamsSchema, {
        agentId: "research",
        source: "/tmp/private",
      }),
    ).toBe(false);
  });

  it("requires a non-empty unique item selection for apply", () => {
    expect(
      Value.Check(MigrationsMemoryApplyParamsSchema, {
        idempotencyKey: "memory-import-1",
        agentId: "research",
        providerId: "codex",
        planFingerprint: "a".repeat(64),
        itemIds: ["memory:codex:MEMORY.md"],
      }),
    ).toBe(true);
    expect(
      Value.Check(MigrationsMemoryApplyParamsSchema, {
        idempotencyKey: "memory-import-1",
        agentId: "research",
        providerId: "codex",
        planFingerprint: "a".repeat(64),
        itemIds: [],
      }),
    ).toBe(false);
    expect(
      Value.Check(MigrationsMemoryApplyParamsSchema, {
        idempotencyKey: "memory-import-1",
        agentId: "research",
        providerId: "codex",
        planFingerprint: "a".repeat(64),
        itemIds: ["memory:codex:MEMORY.md", "memory:codex:MEMORY.md"],
      }),
    ).toBe(false);
    expect(
      Value.Check(MigrationsMemoryApplyParamsSchema, {
        idempotencyKey: "memory-import-1",
        agentId: "research",
        providerId: "codex",
        planFingerprint: "not-a-fingerprint",
        itemIds: ["memory:codex:MEMORY.md"],
      }),
    ).toBe(false);
    expect(
      Value.Check(MigrationsMemoryApplyParamsSchema, {
        agentId: "research",
        providerId: "codex",
        planFingerprint: "a".repeat(64),
        itemIds: ["memory:codex:MEMORY.md"],
      }),
    ).toBe(false);
  });
});
