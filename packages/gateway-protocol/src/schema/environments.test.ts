import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  EnvironmentsCreateResultSchema,
  EnvironmentsDestroyResultSchema,
  EnvironmentsListResultSchema,
  EnvironmentSummarySchema,
  validateEnvironmentsCreateParams,
  validateEnvironmentsDestroyParams,
  WorkerEnvironmentStateSchema,
} from "../index.js";

const workerStates = [
  "requested",
  "provisioning",
  "bootstrapping",
  "ready",
  "attached",
  "idle",
  "draining",
  "destroying",
  "destroyed",
  "failed",
  "orphaned",
] as const;

function workerSummary(
  state: (typeof workerStates)[number],
  status: "available" | "unavailable" | "starting" = "starting",
) {
  return {
    id: "environment-1",
    type: "worker",
    label: "Development worker",
    status,
    worker: {
      providerId: "static-ssh",
      state,
      ageMs: 250,
      attachedSessionIds: [],
      tunnelStatus: "stopped",
    },
  };
}

describe("worker environment protocol schemas", () => {
  it("accepts configured-profile create and environment-id destroy requests", () => {
    expect(
      validateEnvironmentsCreateParams({ profileId: "development", idempotencyKey: "request-1" }),
    ).toBe(true);
    expect(validateEnvironmentsDestroyParams({ environmentId: "environment-1" })).toBe(true);
  });

  it("rejects missing, empty, and unknown lifecycle request fields", () => {
    expect(validateEnvironmentsCreateParams({})).toBe(false);
    expect(validateEnvironmentsCreateParams({ profileId: "", idempotencyKey: "request-1" })).toBe(
      false,
    );
    expect(validateEnvironmentsCreateParams({ profileId: "development", idempotencyKey: "" })).toBe(
      false,
    );
    expect(
      validateEnvironmentsCreateParams({
        profileId: "development",
        idempotencyKey: "request-1",
        providerId: "ssh",
      }),
    ).toBe(false);
    expect(validateEnvironmentsDestroyParams({ environmentId: "" })).toBe(false);
    expect(validateEnvironmentsDestroyParams({ environmentId: "environment-1", force: true })).toBe(
      true,
    );
  });

  it("keeps the worker lifecycle state closed", () => {
    for (const state of workerStates) {
      expect(Value.Check(WorkerEnvironmentStateSchema, state)).toBe(true);
    }
    expect(Value.Check(WorkerEnvironmentStateSchema, "unknown")).toBe(false);
  });

  it("accepts worker metadata additively across summary and mutation results", () => {
    const requested = workerSummary("requested");
    const destroyedBase = workerSummary("destroyed", "unavailable");
    const destroyed = {
      ...destroyedBase,
      worker: {
        ...destroyedBase.worker,
        leaseId: "lease-1",
        idleMs: 50,
      },
    };

    expect(Value.Check(EnvironmentSummarySchema, requested)).toBe(true);
    expect(Value.Check(EnvironmentsCreateResultSchema, requested)).toBe(true);
    expect(Value.Check(EnvironmentsDestroyResultSchema, destroyed)).toBe(true);
  });

  it("lists configured worker profiles without provider settings", () => {
    expect(
      Value.Check(EnvironmentsListResultSchema, {
        environments: [],
        profiles: [{ id: "aws", providerId: "crabbox" }],
      }),
    ).toBe(true);
    expect(
      Value.Check(EnvironmentsListResultSchema, {
        environments: [],
        profiles: [{ id: "aws", providerId: "crabbox", settings: { token: "hidden" } }],
      }),
    ).toBe(false);
  });

  it("preserves summaries without worker metadata and rejects malformed worker metadata", () => {
    expect(
      Value.Check(EnvironmentSummarySchema, {
        id: "gateway",
        type: "local",
        status: "available",
      }),
    ).toBe(true);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...workerSummary("ready", "available"),
        worker: { ...workerSummary("ready", "available").worker, ageMs: -1 },
      }),
    ).toBe(false);
    expect(
      Value.Check(EnvironmentSummarySchema, {
        ...workerSummary("attached", "available"),
        worker: {
          ...workerSummary("attached", "available").worker,
          attachedSessionIds: [""],
        },
      }),
    ).toBe(false);
  });
});
