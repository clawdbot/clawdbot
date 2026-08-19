import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionPlacementMoveSchema,
  SessionPlacementSchema,
  SessionPlacementStateSchema,
  validateSessionsDispatchParams,
  validateSessionsMoveParams,
  validateSessionsMoveResult,
  validateSessionsReclaimParams,
  validateSessionsReclaimResult,
} from "../index.js";

const placementStates = [
  "local",
  "requested",
  "provisioning",
  "syncing",
  "starting",
  "active",
  "draining",
  "reconciling",
  "reclaimed",
  "failed",
] as const;

const basePlacement = {
  generation: 4,
  createdAtMs: 100,
  updatedAtMs: 200,
  stateChangedAtMs: 150,
};
const workerBundleHash = "a".repeat(64);
const environmentFields = {
  environmentId: "environment-1",
  workerBundleHash,
};
const workspaceFields = {
  workspaceBaseManifestRef: "manifest-1",
  remoteWorkspaceDir: "/workspace/session-1",
};
const workerOwnedFields = {
  ...environmentFields,
  ...workspaceFields,
  activeOwnerEpoch: 7,
};

describe("session dispatch protocol schemas", () => {
  it("accepts exactly one profile or device dispatch target", () => {
    expect(
      validateSessionsDispatchParams({
        key: "agent:main:dispatch",
        agentId: "main",
        profileId: "development",
        machineClass: "beast",
      }),
    ).toBe(true);
    expect(
      validateSessionsDispatchParams({
        key: "agent:main:dispatch",
        deviceId: "device-1",
      }),
    ).toBe(true);
    expect(validateSessionsDispatchParams({ key: "agent:main:dispatch" })).toBe(false);
    expect(
      validateSessionsDispatchParams({
        key: "agent:main:dispatch",
        profileId: "development",
        deviceId: "device-1",
      }),
    ).toBe(false);
    expect(
      validateSessionsDispatchParams({
        key: "agent:main:dispatch",
        deviceId: "device-1",
        machineClass: "beast",
      }),
    ).toBe(false);
    expect(
      validateSessionsDispatchParams({
        key: "agent:main:dispatch",
        profileId: "development",
        machineClass: "",
      }),
    ).toBe(false);
    expect(
      validateSessionsDispatchParams({
        key: "agent:main:dispatch",
        profileId: "development",
        machineClass: "x".repeat(129),
      }),
    ).toBe(false);
    expect(
      validateSessionsDispatchParams({
        key: "agent:main:dispatch",
        profileId: "development",
        task: "run remotely",
      }),
    ).toBe(false);
  });

  it("accepts only a session selector for worker reclaim", () => {
    expect(validateSessionsReclaimParams({ key: "agent:main:dispatch", agentId: "main" })).toBe(
      true,
    );
    expect(validateSessionsReclaimParams({ key: "agent:main:dispatch", profileId: "dev" })).toBe(
      false,
    );
  });

  it("accepts exactly the reclaim owner's terminal outcomes", () => {
    const result = {
      ok: true,
      key: "agent:main:dispatch",
      sessionId: "session-dispatch",
    };

    expect(
      validateSessionsReclaimResult({
        ...result,
        placement: { state: "local", ...basePlacement },
      }),
    ).toBe(true);
    expect(
      validateSessionsReclaimResult({
        ...result,
        placement: { state: "reclaimed", ...basePlacement },
      }),
    ).toBe(true);
    for (const placement of [
      { state: "requested", ...basePlacement },
      { state: "active", ...basePlacement, ...workerOwnedFields },
    ]) {
      expect(validateSessionsReclaimResult({ ...result, placement })).toBe(false);
    }
  });

  it("keeps placement states closed", () => {
    for (const state of placementStates) {
      expect(Value.Check(SessionPlacementStateSchema, state)).toBe(true);
    }
    expect(Value.Check(SessionPlacementStateSchema, "unknown")).toBe(false);
  });

  it("keeps local and requested placement free of worker metadata", () => {
    expect(Value.Check(SessionPlacementSchema, { state: "local", ...basePlacement })).toBe(true);
    expect(Value.Check(SessionPlacementSchema, { state: "requested", ...basePlacement })).toBe(
      true,
    );
    expect(
      Value.Check(SessionPlacementSchema, {
        state: "local",
        ...basePlacement,
        environmentId: "environment-1",
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionPlacementSchema, {
        state: "requested",
        ...basePlacement,
        workerBundleHash,
      }),
    ).toBe(false);
  });

  it("allows only the optional reserved environment while provisioning", () => {
    expect(
      Value.Check(SessionPlacementSchema, {
        state: "provisioning",
        ...basePlacement,
        environmentId: "environment-1",
      }),
    ).toBe(true);
    expect(Value.Check(SessionPlacementSchema, { state: "provisioning", ...basePlacement })).toBe(
      true,
    );
    expect(
      Value.Check(SessionPlacementSchema, {
        state: "provisioning",
        ...basePlacement,
        ...environmentFields,
      }),
    ).toBe(false);
  });

  it("requires the provisioned bundle while syncing", () => {
    expect(
      Value.Check(SessionPlacementSchema, {
        state: "syncing",
        ...basePlacement,
        ...environmentFields,
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionPlacementSchema, {
        state: "syncing",
        ...basePlacement,
        environmentId: "environment-1",
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionPlacementSchema, {
        state: "syncing",
        ...basePlacement,
        ...environmentFields,
        ...workspaceFields,
      }),
    ).toBe(false);
  });

  it("requires workspace identity while starting", () => {
    expect(
      Value.Check(SessionPlacementSchema, {
        state: "starting",
        ...basePlacement,
        ...environmentFields,
        ...workspaceFields,
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionPlacementSchema, {
        state: "starting",
        ...basePlacement,
        ...environmentFields,
        remoteWorkspaceDir: "/workspace/session-1",
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionPlacementSchema, {
        state: "starting",
        ...basePlacement,
        ...environmentFields,
        ...workspaceFields,
        lastTranscriptAckCursor: 0,
      }),
    ).toBe(false);
  });

  it.each(["active", "draining", "reconciling"] as const)(
    "requires complete worker ownership for %s placement",
    (state) => {
      expect(
        Value.Check(SessionPlacementSchema, {
          state,
          ...basePlacement,
          ...workerOwnedFields,
          lastTranscriptAckCursor: 2,
          lastLiveEventAckCursor: 9,
        }),
      ).toBe(true);
      expect(
        Value.Check(SessionPlacementSchema, {
          state,
          ...basePlacement,
          environmentId: "environment-1",
          activeOwnerEpoch: 7,
          workerBundleHash,
        }),
      ).toBe(false);
    },
  );

  it("bounds optional worker-owned disk-space observations", () => {
    for (const status of ["ok", "warning", "critical"] as const) {
      expect(
        Value.Check(SessionPlacementSchema, {
          state: "active",
          ...basePlacement,
          ...workerOwnedFields,
          diskSpace: {
            status,
            availableBytes: 200,
            totalBytes: 1_000,
            observedAtMs: 300,
          },
        }),
      ).toBe(true);
    }
    for (const diskSpace of [
      { status: "unknown", availableBytes: 200, totalBytes: 1_000, observedAtMs: 300 },
      { status: "warning", availableBytes: -1, totalBytes: 1_000, observedAtMs: 300 },
      { status: "warning", availableBytes: 1.5, totalBytes: 1_000, observedAtMs: 300 },
      {
        status: "warning",
        availableBytes: 200,
        totalBytes: Number.MAX_SAFE_INTEGER + 1,
        observedAtMs: 300,
      },
    ]) {
      expect(
        Value.Check(SessionPlacementSchema, {
          state: "active",
          ...basePlacement,
          ...workerOwnedFields,
          diskSpace,
        }),
      ).toBe(false);
    }
  });

  it("preserves optional provenance only in terminal states", () => {
    expect(Value.Check(SessionPlacementSchema, { state: "reclaimed", ...basePlacement })).toBe(
      true,
    );
    expect(
      Value.Check(SessionPlacementSchema, {
        state: "reclaimed",
        ...basePlacement,
        ...workerOwnedFields,
        workspaceResultConflict: {
          paths: ["src/local.ts"],
          stagedResultRef: "refs/openclaw/worker-results/claim-1",
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionPlacementSchema, {
        state: "reclaimed",
        ...basePlacement,
        workspaceResultConflict: {
          paths: [],
          stagedResultRef: "refs/openclaw/worker-results/claim-1",
        },
      }),
    ).toBe(false);
  });

  it("requires recovery evidence for failed placement", () => {
    const failed = {
      state: "failed" as const,
      ...basePlacement,
      ...workerOwnedFields,
      recoveryError: "worker admission failed",
    };
    expect(Value.Check(SessionPlacementSchema, failed)).toBe(true);
    expect(
      Value.Check(SessionPlacementSchema, {
        state: "failed",
        ...basePlacement,
      }),
    ).toBe(false);
  });

  it("rejects unknown placement fields", () => {
    expect(
      Value.Check(SessionPlacementSchema, {
        state: "active",
        ...basePlacement,
        ...workerOwnedFields,
        unexpected: true,
      }),
    ).toBe(false);
  });

  it("rejects extra fields in dispatch params", () => {
    expect(
      validateSessionsDispatchParams({
        key: "agent:main:dispatch",
        profileId: "development",
        extra: true,
      }),
    ).toBe(false);
  });

  it.each([
    { kind: "gateway" },
    { kind: "profile", profileId: "development", machineClass: "beast" },
    { kind: "device", deviceId: "device-1" },
  ] as const)("accepts the closed $kind move target", (target) => {
    expect(
      validateSessionsMoveParams({
        key: "agent:main:dispatch",
        agentId: "main",
        expected: { generation: 4, environmentId: "environment-1", ownerEpoch: 7 },
        target,
      }),
    ).toBe(true);
  });

  it("bounds move source and target identifiers", () => {
    const accepted = "x".repeat(256);
    const rejected = "x".repeat(257);
    expect(
      validateSessionsMoveParams({
        key: "agent:main:dispatch",
        expected: { generation: 4, environmentId: accepted, ownerEpoch: 7 },
        target: { kind: "profile", profileId: accepted, machineClass: "x".repeat(128) },
      }),
    ).toBe(true);
    for (const machineClass of ["", "x".repeat(129)]) {
      expect(
        validateSessionsMoveParams({
          key: "agent:main:dispatch",
          expected: { generation: 4, environmentId: "environment-1", ownerEpoch: 7 },
          target: { kind: "profile", profileId: "development", machineClass },
        }),
      ).toBe(false);
    }
    for (const value of [rejected, " leading", "trailing "]) {
      expect(
        validateSessionsMoveParams({
          key: "agent:main:dispatch",
          expected: { generation: 4, environmentId: value, ownerEpoch: 7 },
          target: { kind: "gateway" },
        }),
      ).toBe(false);
      expect(
        validateSessionsMoveParams({
          key: "agent:main:dispatch",
          expected: { generation: 4, environmentId: "environment-1", ownerEpoch: 7 },
          target: { kind: "device", deviceId: value },
        }),
      ).toBe(false);
    }
  });

  it.each([
    { kind: "gateway", profileId: "development" },
    { kind: "gateway", machineClass: "beast" },
    { kind: "profile" },
    { kind: "profile", profileId: "development", deviceId: "device-1" },
    { kind: "device" },
    { kind: "device", deviceId: "device-1", machineClass: "beast" },
    { kind: "other" },
  ])("rejects an invalid or mixed move target %#", (target) => {
    expect(
      validateSessionsMoveParams({
        key: "agent:main:dispatch",
        expected: { generation: 4, environmentId: "environment-1", ownerEpoch: 7 },
        target,
      }),
    ).toBe(false);
  });

  it.each([
    { generation: -1, environmentId: "environment-1", ownerEpoch: 7 },
    { generation: 1.5, environmentId: "environment-1", ownerEpoch: 7 },
    { generation: 4, environmentId: "", ownerEpoch: 7 },
    { generation: 4, environmentId: "environment-1", ownerEpoch: 0 },
    { generation: 4, environmentId: "environment-1", ownerEpoch: 7, extra: true },
  ])("rejects an inexact move source %#", (expected) => {
    expect(
      validateSessionsMoveParams({
        key: "agent:main:dispatch",
        expected,
        target: { kind: "gateway" },
      }),
    ).toBe(false);
  });

  it("projects bounded durable move progress without operation authority", () => {
    expect(
      Value.Check(SessionPlacementMoveSchema, {
        target: { kind: "gateway" },
        updatedAtMs: 1,
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionPlacementMoveSchema, {
        target: { kind: "device", deviceId: "device-1" },
        updatedAtMs: 2,
        error: "device worker is offline",
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionPlacementMoveSchema, {
        target: { kind: "gateway" },
        updatedAtMs: 1,
        operationId: "move:v1:secret",
      }),
    ).toBe(false);
  });

  it("keeps the move result bounded to terminal placement state", () => {
    const result = {
      ok: true,
      key: "agent:main:dispatch",
      sessionId: "session-dispatch",
      placement: { state: "active", generation: 5 },
    };
    expect(validateSessionsMoveResult(result)).toBe(true);
    for (const state of ["requested", "reclaimed"] as const) {
      expect(
        validateSessionsMoveResult({
          ...result,
          placement: { state, generation: result.placement.generation },
        }),
      ).toBe(false);
    }
    expect(
      validateSessionsMoveResult({
        ...result,
        placement: {
          ...result.placement,
          remoteWorkspaceDir: "/workspace/session-dispatch",
        },
      }),
    ).toBe(false);
    expect(validateSessionsMoveResult({ ...result, providerSettings: {} })).toBe(false);
  });
});
