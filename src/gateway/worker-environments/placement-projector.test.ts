import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionPlacementSchema } from "../../../packages/gateway-protocol/src/index.js";
import { projectWorkerSessionPlacement } from "./placement-projector.js";
import type { WorkerSessionPlacementRecord } from "./placement-store.js";

const BUNDLE_HASH = "a".repeat(64);

const RECORD_BASE = {
  sessionId: "session-1",
  agentId: "main",
  sessionKey: "agent:main:session-1",
  generation: 4,
  workspaceBaseManifestRef: null,
  remoteWorkspaceDir: null,
  workerBundleHash: null,
  lastTranscriptAckCursor: null,
  lastLiveEventAckCursor: null,
  recoveryError: null,
  turnClaim: null,
  createdAtMs: 100,
  updatedAtMs: 200,
  stateChangedAtMs: 150,
};

describe("worker placement projection", () => {
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
        environmentId: "environment-1",
        activeOwnerEpoch: 7,
        workspaceBaseManifestRef: "manifest-1",
        remoteWorkspaceDir: "/workspace",
        workerBundleHash: BUNDLE_HASH,
      },
      {
        ...RECORD_BASE,
        state: "failed",
        environmentId: "environment-1",
        activeOwnerEpoch: 7,
        recoveryError: "worker unavailable",
      },
    ] satisfies WorkerSessionPlacementRecord[];

    const projected = records.map(projectWorkerSessionPlacement);

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
