import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import type { WorkerProfile, WorkerSshEndpoint } from "../../plugins/types.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  OPENCLAW_STATE_SCHEMA_VERSION,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { hashWorkerCredential } from "./credential.js";
import {
  createWorkerEnvironmentStore,
  normalizeWorkerSshEndpoint,
  type WorkerEnvironmentStore,
} from "./store.js";

type WorkerEnvironmentBootstrapReceipt = WorkerAdmissionHandshake;
type WorkerEnvironmentProfileSnapshot = WorkerProfile;
type WorkerEnvironmentSshEndpoint = WorkerSshEndpoint;

const HOST_KEY = ["ssh-ed25519", "AAAA"].join(" ");
const SSH_ENDPOINT: WorkerEnvironmentSshEndpoint = {
  host: "worker.example.test",
  port: 2222,
  fallbackPorts: [22, 2200],
  user: "openclaw",
  hostKey: HOST_KEY,
  keyRef: {
    source: "file",
    provider: "worker-keys",
    id: "/static-development-key",
  },
};
const BOOTSTRAP_RECEIPT: WorkerEnvironmentBootstrapReceipt = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.7.1",
  protocolFeatures: ["workspace-sync-v1", "model-proxy-v1"],
};
const CREDENTIAL = ["worker", "credential", "fixture"].join("-");

describe("worker environment store", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerEnvironmentStore;
  let nowMs: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-env-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    nowMs = 1_000;
    store = createWorkerEnvironmentStore({ database, now: () => nowMs });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function createIntent(
    environmentId = "worker-1",
    profileSnapshot: WorkerEnvironmentProfileSnapshot = {
      settings: { region: "test" },
      lifetime: { idleMinutes: 10 },
    },
  ) {
    return store.createIntent({
      environmentId,
      providerId: "fake-provider",
      profileId: "test-profile",
      profileSnapshot,
      provisionOperationId: `provision:${environmentId}`,
    });
  }

  function fallbackPortRows(environmentId: string) {
    return database.db
      .prepare(
        `SELECT position, port
         FROM worker_environment_ssh_fallback_ports
         WHERE environment_id = ?
         ORDER BY position`,
      )
      .all(environmentId);
  }

  function seedBootstrapping(environmentId: string, leaseId: string) {
    createIntent(environmentId);
    store.transition({ environmentId, from: "requested", to: "provisioning" });
    return store.transition({
      environmentId,
      from: "provisioning",
      to: "bootstrapping",
      patch: { leaseId, sshEndpoint: SSH_ENDPOINT },
    });
  }

  function readyPatch(receipt = BOOTSTRAP_RECEIPT) {
    return {
      bootstrapReceipt: receipt,
      credential: {
        credentialHash: hashWorkerCredential(CREDENTIAL),
        sessionId: null,
        rpcSetVersion: 1,
        expiresAtMs: nowMs + 10_000,
      },
    };
  }

  function attachedPatch(sessionId: string, suffix: string) {
    return {
      attachedSessionIds: [sessionId],
      credential: {
        credentialHash: hashWorkerCredential([CREDENTIAL, suffix].join("-")),
        sessionId,
        rpcSetVersion: 1,
        expiresAtMs: nowMs + 10_000,
      },
    };
  }

  it("persists immutable intent before provisioning and survives reopen", () => {
    const snapshot = { settings: { region: "original" }, lifetime: { idleMinutes: 10 } };
    expect(createIntent("worker-crash", snapshot)).toMatchObject({
      environmentId: "worker-crash",
      providerId: "fake-provider",
      profileId: "test-profile",
      profileSnapshot: snapshot,
      provisionOperationId: "provision:worker-crash",
      leaseId: null,
      sshEndpoint: null,
      bootstrapReceipt: null,
      teardownTerminalState: null,
      state: "requested",
      attachedSessionIds: [],
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
      stateChangedAtMs: 1_000,
      destroyRequestedAtMs: null,
      lastError: null,
    });

    snapshot.settings.region = "mutated-after-create";
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerEnvironmentStore({ database, now: () => nowMs });

    expect(store.get("worker-crash")?.profileSnapshot).toEqual({
      settings: { region: "original" },
      lifetime: { idleMinutes: 10 },
    });
  });

  it("persists a destroy request without inventing an unleased lifecycle state", () => {
    createIntent("worker-cancelled");
    nowMs = 1_050;

    expect(
      store.requestDestroy({ environmentId: "worker-cancelled", state: "requested" }),
    ).toMatchObject({
      state: "requested",
      leaseId: null,
      destroyRequestedAtMs: 1_050,
      teardownTerminalState: "destroyed",
      updatedAtMs: 1_050,
    });

    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerEnvironmentStore({ database, now: () => nowMs });
    expect(store.get("worker-cancelled")?.destroyRequestedAtMs).toBe(1_050);
  });

  it("persists the complete lifecycle with canonical attachment metadata", () => {
    createIntent();
    nowMs = 1_010;
    store.transition({ environmentId: "worker-1", from: "requested", to: "provisioning" });
    nowMs = 1_020;
    store.transition({
      environmentId: "worker-1",
      from: "provisioning",
      to: "bootstrapping",
      patch: { leaseId: "lease-1", sshEndpoint: SSH_ENDPOINT },
    });
    nowMs = 1_030;
    store.transition({
      environmentId: "worker-1",
      from: "bootstrapping",
      to: "ready",
      patch: readyPatch(),
    });
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerEnvironmentStore({ database, now: () => nowMs });
    expect(store.get("worker-1")).toMatchObject({
      sshEndpoint: SSH_ENDPOINT,
      bootstrapReceipt: {
        ...BOOTSTRAP_RECEIPT,
        protocolFeatures: ["model-proxy-v1", "workspace-sync-v1"],
      },
    });
    expect(store.list()[0]?.sshEndpoint).toEqual(SSH_ENDPOINT);
    expect(fallbackPortRows("worker-1")).toEqual([
      { position: 0, port: 22 },
      { position: 1, port: 2200 },
    ]);
    nowMs = 1_040;
    expect(
      store.transition({
        environmentId: "worker-1",
        from: "ready",
        to: "attached",
        patch: { ...attachedPatch("session-a", "session-a"), attachedSessionIds: [" session-a "] },
      }),
    ).toMatchObject({
      state: "attached",
      attachedSessionIds: ["session-a"],
      leaseId: "lease-1",
      sshEndpoint: SSH_ENDPOINT,
    });
    nowMs = 1_050;
    expect(
      store.transition({ environmentId: "worker-1", from: "attached", to: "idle" }),
    ).toMatchObject({ state: "idle", attachedSessionIds: [], idleSinceAtMs: 1_050 });
    nowMs = 1_055;
    store.transition({
      environmentId: "worker-1",
      from: "idle",
      to: "attached",
      patch: attachedPatch("session-c", "session-c"),
    });
    nowMs = 1_060;
    expect(
      store.transition({ environmentId: "worker-1", from: "attached", to: "draining" }),
    ).toMatchObject({ state: "draining", attachedSessionIds: [] });
    nowMs = 1_070;
    store.transition({ environmentId: "worker-1", from: "draining", to: "destroying" });

    expect(store.listForReconcile().map((record) => record.state)).toEqual(["destroying"]);
    nowMs = 1_080;
    expect(
      store.transition({ environmentId: "worker-1", from: "destroying", to: "destroyed" }),
    ).toMatchObject({
      state: "destroyed",
      stateChangedAtMs: 1_080,
      idleSinceAtMs: null,
      attachedSessionIds: [],
      sshEndpoint: SSH_ENDPOINT,
    });
    expect(fallbackPortRows("worker-1")).toEqual([
      { position: 0, port: 22 },
      { position: 1, port: 2200 },
    ]);
    expect(store.listForReconcile()).toEqual([]);
  });

  it("replaces ordered SSH fallback rows when the endpoint changes", () => {
    seedBootstrapping("worker-endpoint-change", "lease-endpoint-change");
    const replacement = { ...SSH_ENDPOINT, fallbackPorts: [2201, 22] };

    expect(
      store.transition({
        environmentId: "worker-endpoint-change",
        from: "bootstrapping",
        to: "ready",
        patch: { ...readyPatch(), sshEndpoint: replacement },
      }).sshEndpoint,
    ).toEqual(replacement);
    expect(fallbackPortRows("worker-endpoint-change")).toEqual([
      { position: 0, port: 2201 },
      { position: 1, port: 22 },
    ]);
  });

  it("lazily ensures the companion table once for a current database", () => {
    const databasePath = database.path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const current = new DatabaseSync(databasePath);
    current.exec("DROP TABLE worker_environment_ssh_fallback_ports;");
    current.close();

    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    expect(
      database.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("worker_environment_ssh_fallback_ports"),
    ).toBeUndefined();
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });

    store = createWorkerEnvironmentStore({ database, now: () => nowMs });
    createWorkerEnvironmentStore({ database, now: () => nowMs });
    expect(
      database.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("worker_environment_ssh_fallback_ports"),
    ).toEqual({ name: "worker_environment_ssh_fallback_ports" });
    expect(() =>
      assertOpenClawStateDatabaseForMaintenance(database.db, {
        pathname: database.path,
      }),
    ).not.toThrow();
  });

  it("enforces canonical companion-table constraints and cascading ownership", () => {
    createIntent("worker-constraints");
    expect(
      database.db
        .prepare(
          "SELECT strict FROM pragma_table_list WHERE name = 'worker_environment_ssh_fallback_ports'",
        )
        .get(),
    ).toEqual({ strict: 1 });
    const insert = database.db.prepare(
      `INSERT INTO worker_environment_ssh_fallback_ports (environment_id, position, port)
       VALUES (?, ?, ?)`,
    );
    expect(() => insert.run("worker-constraints", -1, 22)).toThrow();
    expect(() => insert.run("worker-constraints", 10, 22)).toThrow();
    expect(() => insert.run("worker-constraints", 0, 0)).toThrow();
    expect(() => insert.run("worker-constraints", 0, 65_536)).toThrow();
    expect(() => insert.run("missing-worker", 0, 22)).toThrow();

    insert.run("worker-constraints", 0, 22);
    expect(() => insert.run("worker-constraints", 0, 2200)).toThrow();
    expect(() => insert.run("worker-constraints", 1, 22)).toThrow();
    database.db
      .prepare("DELETE FROM worker_environments WHERE environment_id = ?")
      .run("worker-constraints");
    expect(fallbackPortRows("worker-constraints")).toEqual([]);
  });

  it("normalizes provider-advertised SSH fallback ports at the durable boundary", () => {
    expect(
      normalizeWorkerSshEndpoint({
        ...SSH_ENDPOINT,
        fallbackPorts: [22, 2200, 22, 2222],
      }),
    ).toEqual(SSH_ENDPOINT);
  });

  it.each([
    ["non-array", "22"],
    ["non-integer", [22.5]],
    ["below range", [0]],
    ["above range", [65_536]],
    ["more than ten", Array.from({ length: 11 }, (_, index) => 2300 + index)],
  ])("rejects %s SSH fallback ports", (_name, fallbackPorts) => {
    expect(() =>
      normalizeWorkerSshEndpoint({
        ...SSH_ENDPOINT,
        fallbackPorts,
      } as unknown as WorkerEnvironmentSshEndpoint),
    ).toThrow("SSH fallback ports");
  });

  it("keeps renewal on one owner epoch and fences session replacement", () => {
    const bootstrapping = seedBootstrapping("worker-owner", "lease-owner");
    store.transition({
      environmentId: bootstrapping.environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: readyPatch(),
    });
    expect(store.get("worker-owner")?.ownerEpoch).toBe(1);
    expect(store.getCredential("worker-owner")).toMatchObject({ ownerEpoch: 1, sessionId: null });

    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerEnvironmentStore({ database, now: () => nowMs });
    const renewal = [CREDENTIAL, "renewal"].join("-");
    expect(
      store.renewCredential({
        environmentId: "worker-owner",
        expectedOwnerEpoch: 1,
        credentialHash: hashWorkerCredential(renewal),
        sessionId: null,
        rpcSetVersion: 1,
        expiresAtMs: nowMs + 20_000,
      }),
    ).toMatchObject({ ownerEpoch: 1, credentialHash: hashWorkerCredential(renewal) });
    expect(store.get("worker-owner")?.ownerEpoch).toBe(1);

    const attached = store.transition({
      environmentId: "worker-owner",
      from: "ready",
      to: "attached",
      expectedOwnerEpoch: 1,
      patch: attachedPatch("session-1", "session"),
    });
    expect(attached.ownerEpoch).toBe(2);
    expect(store.getCredential("worker-owner")).toMatchObject({
      ownerEpoch: 2,
      sessionId: "session-1",
      deliveredAtMs: null,
    });
    expect(() =>
      store.renewCredential({
        environmentId: "worker-owner",
        expectedOwnerEpoch: 1,
        credentialHash: hashWorkerCredential([renewal, "stale"].join("-")),
        sessionId: "session-1",
        rpcSetVersion: 1,
        expiresAtMs: nowMs + 20_000,
      }),
    ).toThrow("owner epoch changed");
  });

  it("allocates globally distinct owner epochs when a session moves environments", () => {
    const makeReady = (environmentId: string, leaseId: string) => {
      const bootstrapping = seedBootstrapping(environmentId, leaseId);
      return store.transition({
        environmentId,
        from: bootstrapping.state,
        to: "ready",
        patch: readyPatch(),
      });
    };

    const firstReady = makeReady("worker-owner-a", "lease-owner-a");
    const first = store.transition({
      environmentId: firstReady.environmentId,
      from: firstReady.state,
      to: "attached",
      patch: attachedPatch("shared-session", firstReady.environmentId),
    });
    const secondReady = makeReady("worker-owner-b", "lease-owner-b");
    expect(() =>
      store.transition({
        environmentId: secondReady.environmentId,
        from: secondReady.state,
        to: "attached",
        patch: attachedPatch("shared-session", secondReady.environmentId),
      }),
    ).toThrow("already attached to worker environment worker-owner-a");
    store.transition({
      environmentId: first.environmentId,
      from: first.state,
      to: "idle",
    });
    database.db
      .prepare(
        `INSERT INTO worker_transcript_commit_heads (
          session_id, run_epoch, environment_id, next_seq, updated_at_ms
        ) VALUES (?, ?, ?, 1, ?)`,
      )
      .run("shared-session", first.ownerEpoch, first.environmentId, nowMs);
    database.db
      .prepare("DELETE FROM worker_environments WHERE environment_id = ?")
      .run(first.environmentId);
    const second = store.transition({
      environmentId: secondReady.environmentId,
      from: secondReady.state,
      to: "attached",
      patch: attachedPatch("shared-session", secondReady.environmentId),
    });

    expect(first.ownerEpoch).toBe(2);
    expect(second.ownerEpoch).toBeGreaterThan(first.ownerEpoch);
  });

  it("rejects illegal, stale, and lease-incomplete transitions", () => {
    createIntent();
    expect(() =>
      store.transition({ environmentId: "worker-1", from: "requested", to: "ready" }),
    ).toThrow("Illegal worker environment transition");

    store.transition({ environmentId: "worker-1", from: "requested", to: "provisioning" });
    expect(() =>
      store.transition({
        environmentId: "worker-1",
        from: "requested",
        to: "provisioning",
      }),
    ).toThrow("state conflict");
    expect(() =>
      store.transition({
        environmentId: "worker-1",
        from: "provisioning",
        to: "bootstrapping",
      }),
    ).toThrow("requires a provider lease");
    expect(() =>
      store.transition({
        environmentId: "worker-1",
        from: "provisioning",
        to: "bootstrapping",
        patch: { leaseId: "lease-1" },
      }),
    ).toThrow("requires an SSH endpoint reference");

    store.transition({
      environmentId: "worker-1",
      from: "provisioning",
      to: "bootstrapping",
      patch: { leaseId: "lease-1", sshEndpoint: SSH_ENDPOINT },
    });
    expect(() =>
      store.transition({
        environmentId: "worker-1",
        from: "bootstrapping",
        to: "ready",
      }),
    ).toThrow("requires a bootstrap receipt");
    expect(() =>
      store.transition({
        environmentId: "worker-1",
        from: "bootstrapping",
        to: "ready",
        patch: { leaseId: "different-lease" },
      }),
    ).toThrow("lease id is immutable");
  });

  it("enforces one credential-bound session and teardown fencing", () => {
    const bootstrapping = seedBootstrapping("worker-multi-session", "lease-multi-session");
    const ready = readyPatch();
    expect(() =>
      store.transition({
        environmentId: bootstrapping.environmentId,
        from: "bootstrapping",
        to: "ready",
        patch: { ...ready, credential: { ...ready.credential, sessionId: "session-1" } },
      }),
    ).toThrow("session does not match");
    store.transition({
      environmentId: bootstrapping.environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: ready,
    });

    expect(() =>
      store.transition({
        environmentId: bootstrapping.environmentId,
        from: "ready",
        to: "attached",
        patch: {
          ...attachedPatch("session-a", "multi"),
          attachedSessionIds: ["session-a", "session-b"],
        },
      }),
    ).toThrow("exactly one session id");

    store.requestDestroy({ environmentId: bootstrapping.environmentId, state: "ready" });
    expect(() =>
      store.transition({
        environmentId: bootstrapping.environmentId,
        from: "ready",
        to: "attached",
        patch: attachedPatch("session-a", "destroying"),
      }),
    ).toThrow("after destroy is requested");
  });

  it("invalidates stale receipts for rebootstrap and replaces them on readiness", () => {
    seedBootstrapping("worker-rebootstrap", "lease-rebootstrap");
    store.transition({
      environmentId: "worker-rebootstrap",
      from: "bootstrapping",
      to: "ready",
      patch: readyPatch(),
    });
    // Existing ready rows may predate bootstrap receipt persistence.
    database.db.exec(`
      UPDATE worker_environments
      SET
        bootstrap_bundle_hash = NULL,
        bootstrap_openclaw_version = NULL,
        bootstrap_protocol_features_json = NULL
      WHERE environment_id = 'worker-rebootstrap';
    `);
    expect(store.get("worker-rebootstrap")).toMatchObject({
      state: "ready",
      bootstrapReceipt: null,
    });
    const beforeAttach = store.get("worker-rebootstrap");
    expect(() =>
      store.transition({
        environmentId: "worker-rebootstrap",
        from: "ready",
        to: "attached",
        expectedOwnerEpoch: beforeAttach?.ownerEpoch,
        patch: attachedPatch("session-1", "legacy"),
      }),
    ).toThrow("requires bootstrap proof");
    expect(store.get("worker-rebootstrap")).toMatchObject({
      state: "ready",
      ownerEpoch: beforeAttach?.ownerEpoch,
      attachedSessionIds: [],
    });
    const idle = store.transition({
      environmentId: "worker-rebootstrap",
      from: "ready",
      to: "idle",
    });

    const bootstrapping = store.transition({
      environmentId: "worker-rebootstrap",
      from: idle.state,
      to: "bootstrapping",
    });
    expect(bootstrapping).toMatchObject({
      state: "bootstrapping",
      bootstrapReceipt: null,
      leaseId: "lease-rebootstrap",
    });

    const nextReceipt = { ...BOOTSTRAP_RECEIPT, bundleHash: "b".repeat(64) };
    expect(
      store.transition({
        environmentId: "worker-rebootstrap",
        from: "bootstrapping",
        to: "ready",
        patch: readyPatch(nextReceipt),
      }),
    ).toMatchObject({
      state: "ready",
      bootstrapReceipt: {
        ...nextReceipt,
        protocolFeatures: ["model-proxy-v1", "workspace-sync-v1"],
      },
    });
  });

  it("requires provider teardown proof before terminal bootstrap failure", () => {
    seedBootstrapping("worker-bootstrap-failed", "lease-bootstrap-failed");

    expect(() =>
      store.transition({
        environmentId: "worker-bootstrap-failed",
        from: "bootstrapping",
        to: "failed",
        patch: { lastError: "node runtime missing" },
      }),
    ).toThrow("Illegal worker environment transition");

    const unrequested = seedBootstrapping(
      "worker-bootstrap-unrequested",
      "lease-bootstrap-unrequested",
    );
    const unrequestedDraining = store.transition({
      environmentId: unrequested.environmentId,
      from: unrequested.state,
      to: "draining",
    });
    const unrequestedDestroying = store.transition({
      environmentId: unrequested.environmentId,
      from: unrequestedDraining.state,
      to: "destroying",
    });
    expect(() =>
      store.transition({
        environmentId: unrequested.environmentId,
        from: unrequestedDestroying.state,
        to: "failed",
        patch: {
          leaseId: null,
          sshEndpoint: null,
          lastError: "node runtime missing",
        },
      }),
    ).toThrow("requires durable provider teardown intent");

    const pending = seedBootstrapping("worker-bootstrap-cleanup", "lease-bootstrap-cleanup");
    const requested = store.requestDestroy({
      environmentId: pending.environmentId,
      state: pending.state,
      terminalState: "failed",
    });
    const draining = store.transition({
      environmentId: pending.environmentId,
      from: requested.state,
      to: "draining",
    });
    const destroying = store.transition({
      environmentId: pending.environmentId,
      from: draining.state,
      to: "destroying",
    });
    expect(destroying.teardownTerminalState).toBe("failed");
    expect(
      store.transition({
        environmentId: pending.environmentId,
        from: destroying.state,
        to: "failed",
        patch: {
          leaseId: null,
          sshEndpoint: null,
          lastError: "node runtime missing; provider teardown completed",
        },
      }),
    ).toMatchObject({
      state: "failed",
      leaseId: null,
      teardownTerminalState: "failed",
    });
    expect(store.get(pending.environmentId)?.sshEndpoint).toBeNull();
    expect(fallbackPortRows(pending.environmentId)).toEqual([]);
  });

  it("persists retryable errors without a self-transition", () => {
    createIntent();
    nowMs = 1_010;
    store.transition({ environmentId: "worker-1", from: "requested", to: "provisioning" });
    const stateChangedAtMs = store.get("worker-1")?.stateChangedAtMs;

    nowMs = 1_020;
    expect(
      store.recordError({
        environmentId: "worker-1",
        state: "provisioning",
        error: "provider temporarily unavailable",
      }),
    ).toMatchObject({
      state: "provisioning",
      stateChangedAtMs,
      updatedAtMs: 1_020,
      lastError: "provider temporarily unavailable",
    });
  });

  it("accepts only SecretRef metadata for persisted SSH keys", () => {
    createIntent();
    store.transition({ environmentId: "worker-1", from: "requested", to: "provisioning" });
    const plaintextEndpoint = {
      ...SSH_ENDPOINT,
      keyRef: "plaintext-private-key",
    } as unknown as WorkerEnvironmentSshEndpoint;
    const noncanonicalEndpoint = {
      ...SSH_ENDPOINT,
      keyRef: { source: "file", provider: "worker-keys", id: "private-key" },
    } as WorkerEnvironmentSshEndpoint;

    for (const sshEndpoint of [plaintextEndpoint, noncanonicalEndpoint]) {
      expect(() =>
        store.transition({
          environmentId: "worker-1",
          from: "provisioning",
          to: "bootstrapping",
          patch: { leaseId: "lease-1", sshEndpoint },
        }),
      ).toThrow("SSH key must be a canonical SecretRef");
    }
  });

  it.each([
    ["missing", undefined],
    ["multiple lines", `${HOST_KEY}\n${HOST_KEY}`],
    ["extra fields", [HOST_KEY, "comment"].join(" ")],
  ])("rejects %s persisted SSH host-key material", (_label, hostKey) => {
    createIntent();
    store.transition({ environmentId: "worker-1", from: "requested", to: "provisioning" });
    const sshEndpoint = { ...SSH_ENDPOINT, hostKey } as unknown as WorkerEnvironmentSshEndpoint;

    expect(() =>
      store.transition({
        environmentId: "worker-1",
        from: "provisioning",
        to: "bootstrapping",
        patch: { leaseId: "lease-1", sshEndpoint },
      }),
    ).toThrow("SSH host key");
  });
});
