import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionPlacementMoveSchema,
  SessionPlacementSchema,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  createWorkerPlacementRunnerAvailabilityReader,
  projectWorkerPlacementMove,
  projectWorkerSessionPlacement,
} from "./placement-projector.js";
import type { WorkerSessionPlacementRecord } from "./placement-store.js";

const BUNDLE_HASH = "a".repeat(64);

const RECORD_BASE = {
  sessionId: "session-1",
  agentId: "main",
  sessionKey: "agent:main:session-1",
  executionMode: "worker-turn" as const,
  generation: 4,
  workspaceBaseManifestRef: null,
  remoteWorkspaceDir: null,
  workerBundleHash: null,
  lastTranscriptAckCursor: null,
  lastLiveEventAckCursor: null,
  recoveryError: null,
  terminalReason: null,
  terminalAtMs: null,
  turnClaim: null,
  createdAtMs: 100,
  updatedAtMs: 200,
  stateChangedAtMs: 150,
};

describe("worker placement projection", () => {
  it("adds an exact active disk-space sample only when supplied", () => {
    const active = {
      ...RECORD_BASE,
      state: "active",
      environmentId: "environment-1",
      activeOwnerEpoch: 7,
      workspaceBaseManifestRef: "manifest-1",
      remoteWorkspaceDir: "/workspace",
      workerBundleHash: BUNDLE_HASH,
    } satisfies WorkerSessionPlacementRecord;
    const diskSpace = {
      status: "critical" as const,
      availableBytes: 50,
      totalBytes: 1_000,
      observedAtMs: 250,
    };

    expect(projectWorkerSessionPlacement(active, diskSpace)).toMatchObject({ diskSpace });
    expect(projectWorkerSessionPlacement(active)).not.toHaveProperty("diskSpace");
  });

  it("projects device availability from the exact active environment and current runner proof", () => {
    const active = {
      ...RECORD_BASE,
      state: "active",
      environmentId: "environment-device",
      activeOwnerEpoch: 7,
      workspaceBaseManifestRef: "manifest-1",
      remoteWorkspaceDir: "/workspace",
      workerBundleHash: BUNDLE_HASH,
    } satisfies WorkerSessionPlacementRecord;
    let connected = false;
    const reader = createWorkerPlacementRunnerAvailabilityReader({
      environments: {
        get: () => ({
          environmentId: active.environmentId,
          providerId: "device",
          leaseId: "lease-device",
          nodeDeviceId: "device-1",
          sharedHost: true,
          state: "attached",
          ownerEpoch: active.activeOwnerEpoch,
          createdAtMs: 1,
          idleSinceAtMs: null,
          attachedSessionIds: [active.sessionId],
          desktopAvailable: false,
          desktopApps: [],
          tunnelStatus: "stopped",
        }),
      },
      hasCurrentDeviceRunner: (deviceId) => deviceId === "device-1" && connected,
    });

    expect(projectWorkerSessionPlacement(active, undefined, reader.read(active))).toMatchObject({
      runner: { kind: "device", status: "offline" },
    });
    expect(reader.version()).toBe(0);
    connected = true;
    reader.markChanged();
    reader.markChanged();
    reader.markChanged();
    expect(projectWorkerSessionPlacement(active, undefined, reader.read(active))).toMatchObject({
      runner: { kind: "device", status: "available" },
    });
    expect(reader.version()).toBe(3);
  });

  it("omits runner availability for non-device and inexact environment owners", () => {
    const active = {
      ...RECORD_BASE,
      state: "active",
      environmentId: "environment-cloud",
      activeOwnerEpoch: 7,
      workspaceBaseManifestRef: "manifest-1",
      remoteWorkspaceDir: "/workspace",
      workerBundleHash: BUNDLE_HASH,
    } satisfies WorkerSessionPlacementRecord;
    const environment: ReturnType<
      Parameters<typeof createWorkerPlacementRunnerAvailabilityReader>[0]["environments"]["get"]
    > = {
      environmentId: active.environmentId,
      providerId: "crabbox",
      leaseId: "lease-cloud",
      nodeDeviceId: null,
      sharedHost: false,
      state: "attached" as const,
      ownerEpoch: active.activeOwnerEpoch,
      createdAtMs: 1,
      idleSinceAtMs: null,
      attachedSessionIds: [active.sessionId],
      desktopAvailable: false,
      desktopApps: [],
      tunnelStatus: "stopped" as const,
    };
    const reader = createWorkerPlacementRunnerAvailabilityReader({
      environments: { get: () => environment },
      hasCurrentDeviceRunner: () => true,
    });
    expect(reader.read(active)).toBeUndefined();
    if (!environment) {
      throw new Error("expected environment fixture");
    }
    environment.providerId = "device";
    environment.nodeDeviceId = "device-1";
    environment.ownerEpoch += 1;
    expect(reader.read(active)).toBeUndefined();
  });

  it("projects move status without exposing operation authority", () => {
    const projected = projectWorkerPlacementMove({
      operationId: "move:v1:opaque",
      sessionId: "session-1",
      source: { generation: 4, environmentId: "environment-1", ownerEpoch: 7 },
      target: { kind: "device", deviceId: "device-1" },
      abandonSource: false,
      lastError: "device worker is offline",
      createdAtMs: 100,
      updatedAtMs: 200,
    });

    expect(projected).toEqual({
      target: { kind: "device", deviceId: "device-1" },
      error: "device worker is offline",
      updatedAtMs: 200,
    });
    expect(Value.Check(SessionPlacementMoveSchema, projected)).toBe(true);
    expect(projected).not.toHaveProperty("operationId");
    expect(projected).not.toHaveProperty("source");
  });

  it("emits only fields valid for each placement discriminator", () => {
    const records = [
      {
        ...RECORD_BASE,
        state: "local",
        environmentId: null,
        activeOwnerEpoch: null,
      },
      {
        ...RECORD_BASE,
        state: "provisioning",
        environmentId: "environment-1",
        activeOwnerEpoch: null,
      },
      {
        ...RECORD_BASE,
        state: "reclaimed",
        terminalAtMs: 250,
        environmentId: "environment-1",
        activeOwnerEpoch: 7,
        workspaceBaseManifestRef: "manifest-1",
        remoteWorkspaceDir: "/workspace",
        workerBundleHash: BUNDLE_HASH,
        workspaceResultConflict: {
          paths: ["src/local.ts"],
          stagedResultRef: "refs/openclaw/worker-results/claim-1",
        },
      },
      {
        ...RECORD_BASE,
        state: "failed",
        environmentId: "environment-1",
        activeOwnerEpoch: 7,
        recoveryError: "worker unavailable",
        terminalReason: "worker unavailable",
        terminalAtMs: 260,
      },
    ] satisfies WorkerSessionPlacementRecord[];

    const projected = records.map((record) => projectWorkerSessionPlacement(record));

    expect(projected).toEqual([
      {
        state: "local",
        generation: 4,
        createdAtMs: 100,
        updatedAtMs: 200,
        stateChangedAtMs: 150,
      },
      {
        state: "provisioning",
        generation: 4,
        createdAtMs: 100,
        updatedAtMs: 200,
        stateChangedAtMs: 150,
        environmentId: "environment-1",
      },
      {
        state: "reclaimed",
        generation: 4,
        createdAtMs: 100,
        updatedAtMs: 200,
        stateChangedAtMs: 150,
        environmentId: "environment-1",
        activeOwnerEpoch: 7,
        workspaceBaseManifestRef: "manifest-1",
        remoteWorkspaceDir: "/workspace",
        workerBundleHash: BUNDLE_HASH,
        workspaceResultConflict: {
          paths: ["src/local.ts"],
          stagedResultRef: "refs/openclaw/worker-results/claim-1",
        },
        terminalAtMs: 250,
      },
      {
        state: "failed",
        generation: 4,
        createdAtMs: 100,
        updatedAtMs: 200,
        stateChangedAtMs: 150,
        environmentId: "environment-1",
        activeOwnerEpoch: 7,
        recoveryError: "worker unavailable",
        terminalReason: "worker unavailable",
        terminalAtMs: 260,
      },
    ]);
    for (const placement of projected) {
      expect(Value.Check(SessionPlacementSchema, placement)).toBe(true);
      expect(placement).not.toHaveProperty("sessionId");
      expect(placement).not.toHaveProperty("sessionKey");
      expect(placement).not.toHaveProperty("turnClaim");
    }
  });
});
