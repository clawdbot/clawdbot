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

  it("accepts canonical readiness subjects and condition references", () => {
    const snapshot = {
      ...snapshotWithPresence({ ts: 1 }),
      health: {
        readiness: {
          evaluatedAtMs: 1_000,
          identity: {
            producerRef: "openclaw/gateway/current",
            subjects: [
              {
                ref: "openclaw/gateway/current",
                kind: "openclaw.gateway",
                id: "gateway-1",
              },
            ],
          },
          ready: true,
          conditions: [
            {
              type: "GatewayResponding",
              subjectRef: "openclaw/gateway/current",
              observedAtMs: 1_000,
              status: "True",
              requirement: "required",
              reason: "GatewayResponding",
              message: "Gateway accepted the readiness request.",
            },
          ],
          failures: [],
          advisories: [],
        },
      },
    };

    expect(Value.Check(SnapshotSchema, snapshot)).toBe(true);
  });
});
