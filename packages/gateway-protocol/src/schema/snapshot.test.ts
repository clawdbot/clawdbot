// Gateway Protocol snapshot schema tests cover optional presence identity.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SnapshotSchema } from "./snapshot.js";

function snapshotWithPresence(presence: Record<string, unknown>) {
  return {
    presence: [presence],
    health: {},
    stateVersion: { presence: 1, health: 1 },
    uptimeMs: 1,
  };
}

describe("SnapshotSchema", () => {
  it("accepts a presence user identity", () => {
    expect(
      Value.Check(
        SnapshotSchema,
        snapshotWithPresence({
          ts: 1,
          user: { id: "alice@example.com", email: "alice@example.com" },
        }),
      ),
    ).toBe(true);
  });

  it("keeps presence user identity optional", () => {
    expect(Value.Check(SnapshotSchema, snapshotWithPresence({ ts: 1 }))).toBe(true);
  });

  it("accepts optional watched session keys", () => {
    expect(
      Value.Check(
        SnapshotSchema,
        snapshotWithPresence({
          ts: 1,
          watchedSessions: ["agent:main:main", "agent:main:work"],
        }),
      ),
    ).toBe(true);
  });

  it("accepts persistent event-loop health duration", () => {
    const snapshot = {
      ...snapshotWithPresence({ ts: 1 }),
      health: {
        eventLoop: {
          degraded: true,
          degradedSinceMs: 61_000,
          reasons: ["event_loop_delay"],
          intervalMs: 30_000,
          delayP99Ms: 1_200,
          delayMaxMs: 1_500,
          utilization: 0.75,
          cpuCoreRatio: 0.5,
        },
      },
    };

    expect(Value.Check(SnapshotSchema, snapshot)).toBe(true);
  });
});
