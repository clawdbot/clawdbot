import { beforeEach, describe, expect, it } from "vitest";
import type { WorkerConnectParams } from "../../../packages/gateway-protocol/src/index.js";
import {
  admitWorkerConnection,
  validateWorkerConnectionIdentity,
  verifyWorkerAdmissionHandshake,
} from "./admission.js";
import { hashWorkerCredential, type WorkerCredentialRecord } from "./credential.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";

const BUNDLE_HASH = "a".repeat(64);
const CREDENTIAL = ["worker", "credential", "fixture"].join("-");
const OTHER_CREDENTIAL = ["other", "credential", "fixture"].join("-");
const RECEIPT = {
  bundleHash: BUNDLE_HASH,
  openclawVersion: "2026.7.11",
  protocolFeatures: ["worker-heartbeat-v1"],
};

describe("worker admission", () => {
  let environment: WorkerEnvironmentRecord;
  let credential: WorkerCredentialRecord;
  let nowMs: number;
  let store: WorkerEnvironmentStore;

  beforeEach(() => {
    nowMs = 1_000;
    environment = {
      environmentId: "worker-1",
      state: "ready",
      ownerEpoch: 1,
      destroyRequestedAtMs: null,
      bootstrapReceipt: RECEIPT,
    } as WorkerEnvironmentRecord;
    credential = {
      environmentId: environment.environmentId,
      credentialHash: hashWorkerCredential(CREDENTIAL),
      bundleHash: BUNDLE_HASH,
      sessionId: null,
      rpcSetVersion: 1,
      ownerEpoch: 1,
      expiresAtMs: 2_000,
      deliveredAtMs: null,
    };
    store = {
      get: (environmentId: string) =>
        environmentId.trim() === environment.environmentId ? environment : undefined,
      getCredential: (environmentId: string) =>
        environmentId.trim() === credential.environmentId ? credential : undefined,
      findCredentialByHash: (hash: string) =>
        hash === credential.credentialHash ? credential : undefined,
    } as WorkerEnvironmentStore;
  });

  type AdmissionCommon = Omit<WorkerConnectParams["admission"], "sessionId" | "runId">;
  type AdmissionOverrides =
    | (Partial<AdmissionCommon> & { sessionId?: null; runId?: null })
    | (Partial<AdmissionCommon> & { sessionId: string; runId: string });
  const admission = (overrides: AdmissionOverrides = {}): WorkerConnectParams["admission"] => {
    const common = {
      environmentId: overrides.environmentId ?? "worker-1",
      credential: overrides.credential ?? CREDENTIAL,
      ownerEpoch: overrides.ownerEpoch ?? 1,
      rpcSetVersion: overrides.rpcSetVersion ?? 1,
      handshake: overrides.handshake ?? RECEIPT,
    };
    if (typeof overrides.sessionId === "string" && typeof overrides.runId === "string") {
      return { ...common, sessionId: overrides.sessionId, runId: overrides.runId };
    }
    return { ...common, sessionId: null, runId: null };
  };
  const admit = (workerAdmission = admission(), expectedBuild: typeof RECEIPT = RECEIPT) =>
    admitWorkerConnection({ store, admission: workerAdmission, expectedBuild, nowMs });

  it("verifies and admits the complete current build identity", () => {
    expect(verifyWorkerAdmissionHandshake(RECEIPT, RECEIPT)).toBe(true);
    const result = admit();
    expect(result).toMatchObject({
      ok: true,
      identity: {
        environmentId: "worker-1",
        sessionId: null,
        runId: null,
        ownerEpoch: 1,
        rpcSetVersion: 1,
        protocolFeatures: ["worker-heartbeat-v1"],
        credentialExpiresAtMs: 2_000,
      },
    });
  });

  it.each([
    ["invalid-credential", () => admission({ credential: OTHER_CREDENTIAL })],
    ["environment-mismatch", () => admission({ environmentId: "worker-other" })],
    ["environment-mismatch", () => admission({ environmentId: " worker-1 " })],
    ["bundle-mismatch", () => admission({ handshake: { ...RECEIPT, bundleHash: "b".repeat(64) } })],
    ["version-mismatch", () => admission({ handshake: { ...RECEIPT, openclawVersion: "other" } })],
    ["session-mismatch", () => admission({ sessionId: "session-other", runId: "run-other" })],
    ["owner-epoch-mismatch", () => admission({ ownerEpoch: 2 })],
    ["rpc-set-mismatch", () => admission({ rpcSetVersion: 2 })],
    [
      "protocol-features-mismatch",
      () => admission({ handshake: { ...RECEIPT, protocolFeatures: ["different-feature"] } }),
    ],
  ] as const)("rejects %s", (reason, buildAdmission) => {
    expect(admit(buildAdmission())).toEqual({ ok: false, reason });
  });

  it("rejects expiry, unavailable state, and the previous gateway build", () => {
    nowMs = credential.expiresAtMs;
    expect(admit()).toEqual({ ok: false, reason: "credential-expired" });
    nowMs = 1_000;
    environment = { ...environment, destroyRequestedAtMs: nowMs };
    expect(admit()).toEqual({ ok: false, reason: "environment-unavailable" });
    environment = { ...environment, destroyRequestedAtMs: null };
    expect(admit(admission(), { ...RECEIPT, bundleHash: "b".repeat(64) })).toEqual({
      ok: false,
      reason: "bundle-mismatch",
    });
  });

  it("fences a live connection after credential rotation", () => {
    const admitted = admit();
    if (!admitted.ok) {
      throw new Error("fixture admission failed");
    }
    credential = { ...credential, credentialHash: hashWorkerCredential(OTHER_CREDENTIAL) };
    expect(validateWorkerConnectionIdentity({ store, identity: admitted.identity, nowMs })).toBe(
      "credential-replaced",
    );
  });
});
