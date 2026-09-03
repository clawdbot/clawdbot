import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  ConfigSchemaLookupResultSchema,
  ConfigSchemaResponseSchema,
  UpdateAvailableSchema,
  UpdateHoldParamsSchema,
  UpdateHoldResultSchema,
  UpdateRunParamsSchema,
  UpdateScheduleStateSchema,
  UpdateStatusParamsSchema,
  UpdateStatusResultSchema,
} from "./config.js";

const response = {
  schema: {},
  uiHints: {
    "channels.sms.fromNumber": {
      docsUrl: "https://docs.openclaw.ai/channels/sms",
      presentation: "phone-number",
    },
  },
  version: "1",
  generatedAt: "2026-07-20T00:00:00.000Z",
};

describe("ConfigSchemaResponseSchema", () => {
  it("accepts the phone-number presentation hint", () => {
    expect(Value.Check(ConfigSchemaResponseSchema, response)).toBe(true);
  });

  it("rejects unknown presentation hint values", () => {
    expect(
      Value.Check(ConfigSchemaResponseSchema, {
        ...response,
        uiHints: {
          "channels.sms.fromNumber": {
            presentation: "telephone",
          },
        },
      }),
    ).toBe(false);
  });
});

describe("ConfigSchemaLookupResultSchema", () => {
  it("accepts a documentation URL in the resolved hint", () => {
    expect(
      Value.Check(ConfigSchemaLookupResultSchema, {
        path: "gateway",
        schema: { type: "object" },
        hint: { docsUrl: "https://docs.openclaw.ai/gateway" },
        children: [],
      }),
    ).toBe(true);
  });
});

describe("update protocol schemas", () => {
  it("accepts optional admitted update requester identity and rejects extra authority", () => {
    const requester = { channel: "slack", accountId: "primary", senderId: "owner" };
    expect(Value.Check(UpdateRunParamsSchema, {})).toBe(true);
    expect(Value.Check(UpdateRunParamsSchema, { requester })).toBe(true);
    expect(
      Value.Check(UpdateRunParamsSchema, { requester: { ...requester, senderIsOwner: true } }),
    ).toBe(false);
    expect(Value.Check(UpdateRunParamsSchema, { requester: { senderId: 123 } })).toBe(false);
  });

  it("accepts only closed, exact tracked Git targets for update.run", () => {
    const target = {
      kind: "git",
      upstreamRef: "origin/main",
      upstreamSha: "1234567890abcdef1234567890abcdef12345678",
    };

    expect(Value.Check(UpdateRunParamsSchema, {})).toBe(true);
    expect(Value.Check(UpdateRunParamsSchema, { target })).toBe(true);

    for (const invalidTarget of [
      { ...target, upstreamSha: "1234567" },
      { ...target, upstreamSha: "g".repeat(40) },
      { ...target, upstreamRef: "" },
      { ...target, upstreamRef: "origin/main branch" },
      { ...target, upstreamRef: "origin/main\u0000" },
      { ...target, kind: "package" },
      { ...target, extra: true },
    ]) {
      expect(Value.Check(UpdateRunParamsSchema, { target: invalidTarget })).toBe(false);
    }
  });

  it("accepts an optional explicit checkout refresh", () => {
    expect(Value.Check(UpdateStatusParamsSchema, {})).toBe(true);
    expect(Value.Check(UpdateStatusParamsSchema, { refreshCheckout: true })).toBe(true);
    expect(Value.Check(UpdateStatusParamsSchema, { refreshCheckout: "yes" })).toBe(false);
  });

  it("accepts package and git schedule targets", () => {
    expect(
      Value.Check(UpdateScheduleStateSchema, {
        channel: "beta",
        autoEnabled: true,
        install: { kind: "package" },
        target: { kind: "package", version: "2026.8.1-beta.1" },
        campaign: {
          id: "campaign-1",
          state: "countdown",
          announcedAtMs: 1,
          applyAtMs: 60_001,
          forceAtMs: 900_001,
          updatedAtMs: 1,
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(UpdateScheduleStateSchema, {
        channel: "dev",
        autoEnabled: true,
        install: { kind: "git" },
        target: {
          kind: "git",
          upstreamRef: "origin/main",
          upstreamSha: "abcdef1234",
          commitsBehind: 3,
        },
      }),
    ).toBe(true);
  });

  it("validates the additive update.status result", () => {
    expect(
      Value.Check(UpdateStatusResultSchema, {
        sentinel: null,
        updateAvailable: {
          currentVersion: "2026.8.1",
          latestVersion: "2026.8.1",
          channel: "dev",
          currentSha: "1234567890",
          upstreamRef: "origin/main",
          upstreamSha: "abcdef1234",
          commitsBehind: 3,
          commits: [
            { sha: "abc1234", subject: "First change" },
            { sha: "def5678", subject: "Second change" },
          ],
        },
        effectiveChannel: "dev",
        schedule: {
          channel: "dev",
          autoEnabled: true,
          install: {
            kind: "git",
            git: {
              status: "behind",
              currentSha: "1234567890",
              commitAtMs: 1_754_640_000_000,
              installedAtMs: 1_754_647_200_000,
              commitsBehind: 3,
            },
          },
          target: {
            kind: "git",
            upstreamRef: "origin/main",
            upstreamSha: "abcdef1234",
            commitsBehind: 3,
          },
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(UpdateStatusResultSchema, {
        sentinel: null,
        updateAvailable: null,
        schedule: {
          channel: "dev",
          autoEnabled: true,
          target: { kind: "git", upstreamRef: "origin/main", commitsBehind: -1 },
        },
      }),
    ).toBe(false);

    for (const git of [
      { status: "current" },
      { status: "ahead", commitsAhead: 2 },
      { status: "diverged", commitsAhead: 1, commitsBehind: 3 },
      { status: "unavailable", reason: "fetch-failed" },
    ]) {
      expect(
        Value.Check(UpdateStatusResultSchema, {
          sentinel: null,
          updateAvailable: null,
          schedule: {
            channel: "dev",
            autoEnabled: false,
            install: { kind: "git", git },
          },
        }),
      ).toBe(true);
    }
    expect(
      Value.Check(UpdateStatusResultSchema, {
        sentinel: null,
        updateAvailable: null,
        schedule: {
          channel: "dev",
          autoEnabled: false,
          install: { kind: "git", git: { status: "behind", commitsBehind: 0 } },
        },
      }),
    ).toBe(false);
  });

  it("accepts optional bounded dev commit summaries", () => {
    const availability = {
      currentVersion: "2026.8.1",
      latestVersion: "2026.8.1",
      channel: "dev",
      currentSha: "1234567890",
      upstreamRef: "origin/main",
      upstreamSha: "abcdef1234",
      commitsBehind: 6,
    };
    expect(Value.Check(UpdateAvailableSchema, availability)).toBe(true);
    expect(
      Value.Check(UpdateAvailableSchema, {
        ...availability,
        commits: [{ sha: "abc1234", subject: "First change" }],
      }),
    ).toBe(true);
    expect(
      Value.Check(UpdateAvailableSchema, {
        ...availability,
        commits: Array.from({ length: 6 }, (_, index) => ({
          sha: `abc123${index}`,
          subject: `Change ${index}`,
        })),
      }),
    ).toBe(false);
  });

  it("validates update.hold params and result", () => {
    expect(Value.Check(UpdateHoldParamsSchema, {})).toBe(true);
    expect(
      Value.Check(UpdateHoldResultSchema, {
        ok: true,
        schedule: {
          channel: "beta",
          autoEnabled: true,
          campaign: {
            id: "campaign-1",
            state: "waiting-for-idle",
            announcedAtMs: 1,
            holdUntilMs: 3_600_001,
            forceAtMs: 4_500_001,
            updatedAtMs: 1,
          },
        },
      }),
    ).toBe(true);
  });
});
