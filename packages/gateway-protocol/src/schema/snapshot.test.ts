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

  it("accepts additive delivery failure classifications and ingress health", () => {
    const snapshot = {
      ...snapshotWithPresence({ ts: 1 }),
      health: {
        deliveryQueues: {
          failed: [
            {
              queueName: "outbound-prepared-v1",
              count: 2,
              full: 1,
              compacted: 1,
              safe: 1,
              ambiguous: 1,
              ownerManaged: 0,
              ownerCleanupPending: 0,
              fenceNone: 1,
              fencePermanent: 1,
              fenceProducerBounded: 0,
              legacyUnknown: 0,
              payloadBearing: 1,
              oldestPayloadFailedAt: 1,
            },
          ],
          ingressFailed: [
            { channelId: "telegram", accountId: "ops", count: 1, oldestFailedAt: 1_000 },
          ],
          maintenance: { lastRunAt: 1, errors: 0 },
          ingressPressure: [
            {
              channelId: "telegram",
              accountId: "ops",
              laneCount: 1,
              pendingCount: 56,
              claimedCount: 0,
              blockedCount: 55,
              oldestReceivedAt: 2_000,
            },
          ],
        },
      },
    };

    expect(Value.Check(SnapshotSchema, snapshot)).toBe(true);
  });

  it("accepts additive update availability and schedule state", () => {
    const snapshot = {
      ...snapshotWithPresence({ ts: 1 }),
      updateAvailable: {
        currentVersion: "2026.8.1",
        latestVersion: "2026.8.1",
        channel: "dev",
        currentSha: "1234567890",
        upstreamRef: "origin/main",
        upstreamSha: "abcdef1234",
        commitsBehind: 2,
      },
      updateSchedule: {
        channel: "dev",
        autoEnabled: true,
        install: { kind: "git" },
        target: {
          kind: "git",
          upstreamRef: "origin/main",
          upstreamSha: "abcdef1234",
          commitsBehind: 2,
        },
      },
    };

    expect(Value.Check(SnapshotSchema, snapshot)).toBe(true);
  });
});
