import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  ConfigSchemaLookupResultSchema,
  ConfigSchemaResponseSchema,
  UpdateScheduleStateSchema,
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
        },
        schedule: {
          channel: "dev",
          autoEnabled: true,
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
  });
});
