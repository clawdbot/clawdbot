import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionPlacementSchema,
  SessionPlacementStateSchema,
  validateSessionsDispatchParams,
  validateSessionsDispatchResult,
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
  it("accepts only the dedicated dispatch selector and configured profile", () => {
    expect(
      validateSessionsDispatchParams({
        key: "agent:main:dispatch",
        agentId: "main",
        profileId: "development",
      }),
    ).toBe(true);
    expect(validateSessionsDispatchParams({ key: "agent:main:dispatch" })).toBe(false);
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

  it("preserves optional provenance only in terminal states", () => {
    expect(Value.Check(SessionPlacementSchema, { state: "reclaimed", ...basePlacement })).toBe(
      true,
    );
    expect(
      Value.Check(SessionPlacementSchema, {
        state: "reclaimed",
        ...basePlacement,
        ...workerOwnedFields,
      }),
    ).toBe(true);
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

  it("accepts only active worker ownership in successful dispatch results", () => {
    const active = {
      state: "active" as const,
      ...basePlacement,
      ...workerOwnedFields,
    };
    expect(
      validateSessionsDispatchResult({
        ok: true,
        key: "agent:main:dispatch",
        sessionId: "session-1",
        placement: active,
      }),
    ).toBe(true);
    expect(
      validateSessionsDispatchResult({
        ok: true,
        key: "agent:main:dispatch",
        sessionId: "session-1",
        placement: {
          state: "failed",
          ...basePlacement,
          recoveryError: "worker admission failed",
        },
      }),
    ).toBe(false);
  });

  it("accepts only reclaimed ownership in successful reclaim results", () => {
    expect(
      validateSessionsReclaimResult({
        ok: true,
        key: "agent:main:dispatch",
        sessionId: "session-1",
        placement: { state: "reclaimed", ...basePlacement, ...workerOwnedFields },
      }),
    ).toBe(true);
    expect(
      validateSessionsReclaimResult({
        ok: true,
        key: "agent:main:dispatch",
        sessionId: "session-1",
        placement: { state: "active", ...basePlacement, ...workerOwnedFields },
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
});
