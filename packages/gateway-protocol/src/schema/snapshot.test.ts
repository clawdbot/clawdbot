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

  it("accepts the optional bounded outbound dead-letter breakdown", () => {
    const snapshot = {
      ...snapshotWithPresence({ ts: 1 }),
      health: {
        deliveryQueues: {
          failed: [{ queueName: "outbound-prepared-v1", count: 2, oldestFailedAt: 1_000 }],
          ingressFailed: [
            { channelId: "telegram", accountId: "default", count: 1, oldestFailedAt: 900 },
          ],
          outboundFailed: {
            count: 2,
            oldestFailedAt: 1_000,
            newestFailedAt: 2_000,
            buckets: [
              {
                queue: "prepared",
                channel: "telegram",
                recoveryState: "unknownAfterSend",
                count: 2,
                oldestFailedAt: 1_000,
                newestFailedAt: 2_000,
              },
            ],
          },
        },
      },
    };

    expect(Value.Check(SnapshotSchema, snapshot)).toBe(true);
  });

  it("rejects unknown categories and extra sensitive breakdown fields", () => {
    const outboundFailed = {
      count: 1,
      buckets: [
        {
          queue: "prepared",
          channel: "telegram",
          recoveryState: "none",
          count: 1,
        },
      ],
    };
    const snapshot = (value: Record<string, unknown>) => ({
      ...snapshotWithPresence({ ts: 1 }),
      health: { deliveryQueues: { failed: [], outboundFailed: value } },
    });

    expect(
      Value.Check(SnapshotSchema, {
        ...snapshot(outboundFailed),
        health: {
          deliveryQueues: {
            failed: [],
            outboundFailed: {
              ...outboundFailed,
              buckets: [{ ...outboundFailed.buckets[0], recoveryState: "private_future_state" }],
            },
          },
        },
      }),
    ).toBe(false);
    expect(Value.Check(SnapshotSchema, snapshot({ ...outboundFailed, accountId: "secret" }))).toBe(
      false,
    );
  });
});
