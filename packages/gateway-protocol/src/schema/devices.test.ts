import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  DevicePairSetupCodeResultSchema,
  DevicePairSetupCompletedEventSchema,
  DevicePairSetupStatusParamsSchema,
  DevicePairSetupStatusResultSchema,
} from "./devices.js";

describe("device pairing setup schemas", () => {
  it("accepts current and older-v4 setup results without exposing the bootstrap credential", () => {
    const result = {
      setupId: "setup-123",
      expiresAtMs: 1_800_000_000_000,
      setupCode: "opaque-code",
      gatewayUrl: "wss://gateway.example",
      auth: "token",
      urlSource: "gateway.remote.url",
      access: "full",
    };

    expect(Value.Check(DevicePairSetupCodeResultSchema, result)).toBe(true);
    expect(
      Value.Check(DevicePairSetupCodeResultSchema, { ...result, bootstrapToken: "secret" }),
    ).toBe(false);
    const { setupId: _setupId, expiresAtMs: _expiresAtMs, ...legacyResult } = result;
    expect(Value.Check(DevicePairSetupCodeResultSchema, legacyResult)).toBe(true);
    expect(Value.Check(DevicePairSetupCodeResultSchema, { ...result, setupId: "" })).toBe(false);
    expect(Value.Check(DevicePairSetupCodeResultSchema, { ...result, expiresAtMs: -1 })).toBe(
      false,
    );
  });

  it.each(["full", "limited", "node"] as const)(
    "accepts a closed %s setup completion event",
    (access) => {
      const event = {
        setupId: "setup-123",
        deviceId: "device-123",
        deviceName: "Phone",
        access,
        ts: 1_800_000_000_001,
      };
      expect(Value.Check(DevicePairSetupCompletedEventSchema, event)).toBe(true);
      expect(
        Value.Check(DevicePairSetupCompletedEventSchema, { ...event, bootstrapToken: "secret" }),
      ).toBe(false);
    },
  );

  it("requires an exact setup id on the reconcile request", () => {
    expect(Value.Check(DevicePairSetupStatusParamsSchema, { setupId: "setup-123" })).toBe(true);
    expect(Value.Check(DevicePairSetupStatusParamsSchema, { setupId: "" })).toBe(false);
    expect(Value.Check(DevicePairSetupStatusParamsSchema, {})).toBe(false);
    expect(
      Value.Check(DevicePairSetupStatusParamsSchema, {
        setupId: "setup-123",
        bootstrapToken: "secret",
      }),
    ).toBe(false);
  });

  it("carries the same completion payload as the broadcast, or none at all", () => {
    const completion = {
      setupId: "setup-123",
      deviceId: "device-123",
      access: "limited",
      ts: 1_800_000_000_001,
    };

    expect(Value.Check(DevicePairSetupStatusResultSchema, {})).toBe(true);
    expect(Value.Check(DevicePairSetupStatusResultSchema, { completion })).toBe(true);
    expect(Value.Check(DevicePairSetupStatusResultSchema, { deliveryUncertain: completion })).toBe(
      true,
    );
    // Retention bookkeeping is store-side and must not reach the wire.
    expect(
      Value.Check(DevicePairSetupStatusResultSchema, {
        completion: { ...completion, retainUntilMs: 1_800_000_600_000 },
      }),
    ).toBe(false);
    expect(Value.Check(DevicePairSetupStatusResultSchema, { completion: { setupId: "a" } })).toBe(
      false,
    );
  });
});
