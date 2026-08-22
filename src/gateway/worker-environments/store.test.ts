import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import type {
  WorkerDesktopEndpoint,
  WorkerProfile,
  WorkerSshEndpoint,
} from "../../plugins/types.js";
import { ensureAdditiveStateColumns } from "../../state/openclaw-state-db-schema-additive.js";
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
  normalizeWorkerDesktopEndpoint,
  normalizeWorkerSshEndpoint,
  type WorkerEnvironmentStore,
} from "./store.js";

type WorkerEnvironmentBootstrapReceipt = WorkerAdmissionHandshake & {
  installKind?: "bundle" | "local";
};
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
const DESKTOP: WorkerDesktopEndpoint = {
  protocol: "rfb",
  port: 5900,
  passwordFilePath: "/var/lib/crabbox/vnc.password",
  apps: [
    {
      id: "browser",
      executablePath: "/usr/local/bin/openclaw-worker-browser",
      cdpPort: 9222,
    },
    { id: "terminal", executablePath: "/usr/local/bin/openclaw-worker-terminal" },
  ],
};
const BOOTSTRAP_RECEIPT: WorkerEnvironmentBootstrapReceipt = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.7.1",
  protocolFeatures: ["workspace-sync-v1", "model-proxy-v1"],
};
const CREDENTIAL = ["worker", "credential", "fixture"].join("-");
const DAY_MS = 24 * 60 * 60 * 1_000;
const PRUNE_NOW_MS = 10 * DAY_MS;

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

  function seedOrphaned(environmentId: string, stateChangedAtMs: number) {
    nowMs = 1_000;
    const bootstrapping = seedBootstrapping(environmentId, `lease:${environmentId}`);
    store.transition({
      environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: readyPatch(),
    });
    nowMs = stateChangedAtMs;
    return store.transition({ environmentId, from: "ready", to: "orphaned" });
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
      patch: { leaseId: "lease-1", sshEndpoint: SSH_ENDPOINT, sharedHost: true },
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
      sharedHost: true,
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

  it("uses the terminal environment index for ordered cleanup", () => {
    const plan = database.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT worker_environments.environment_id
         FROM worker_environments
         LEFT JOIN worker_session_placements
           ON worker_session_placements.environment_id = worker_environments.environment_id
         WHERE worker_environments.state IN ('destroyed', 'failed', 'orphaned')
           AND worker_environments.state_changed_at_ms <= ?
           AND worker_session_placements.session_id IS NULL
         ORDER BY worker_environments.state_changed_at_ms ASC,
                  worker_environments.environment_id ASC
         LIMIT ?`,
      )
      .all(PRUNE_NOW_MS - 7 * DAY_MS, 2) as Array<{ detail: string }>;

    expect(plan.map((row) => row.detail).join("\n")).toContain(
      "idx_worker_environments_terminal_changed",
    );
  });

  it("prunes only old unreferenced terminal environments and cascades owned rows", () => {
    seedOrphaned("worker-old-first", DAY_MS);
    seedOrphaned("worker-old-second", 2 * DAY_MS);
    seedOrphaned("worker-referenced", 3 * DAY_MS);
    seedOrphaned("worker-recent", PRUNE_NOW_MS - 1_000);
    nowMs = 1_000;
    const ready = seedBootstrapping("worker-ready", "lease:worker-ready");
    store.transition({
      environmentId: ready.environmentId,
      from: ready.state,
      to: "ready",
      patch: readyPatch(),
    });
    database.db
      .prepare(
        `INSERT INTO worker_session_placements (
          session_id, agent_id, session_key, state, environment_id, recovery_error,
          created_at_ms, updated_at_ms, state_changed_at_ms
        ) VALUES ('session-referenced', 'agent-1', 'session-key-1', 'failed', ?,
          'worker environment disappeared', 1, 1, 1)`,
      )
      .run("worker-referenced");
    database.db
      .prepare(
        `INSERT INTO worker_inference_turns (
          session_id, run_epoch, run_id, turn_id, environment_id, request_hash,
          state, terminal_json, created_at_ms, updated_at_ms
        ) VALUES ('session-old', 1, 'run-old', 'turn-old', ?, 'hash-old',
          'terminal', '{}', 1, 1)`,
      )
      .run("worker-old-first");
    expect(fallbackPortRows("worker-old-first")).toHaveLength(2);

    expect(store.pruneTerminalEnvironments({ nowMs: PRUNE_NOW_MS, limit: 1 })).toBe(1);
    expect(store.get("worker-old-first")).toBeUndefined();
    expect(fallbackPortRows("worker-old-first")).toEqual([]);
    expect(
      database.db
        .prepare("SELECT environment_id FROM worker_inference_turns WHERE environment_id = ?")
        .get("worker-old-first"),
    ).toBeUndefined();

    expect(store.pruneTerminalEnvironments({ nowMs: PRUNE_NOW_MS, limit: 10 })).toBe(1);
    expect(store.get("worker-old-second")).toBeUndefined();
    expect(store.get("worker-referenced")?.state).toBe("orphaned");
    expect(store.get("worker-recent")?.state).toBe("orphaned");
    expect(store.get("worker-ready")?.state).toBe("ready");
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

  it.each([
    ["a non-array app list", "browser", "desktop apps must be an array"],
    [
      "more than eight apps",
      Array.from({ length: 9 }, () => ({
        id: "terminal",
        executablePath: "/usr/bin/xfce4-terminal",
      })),
      "desktop apps cannot exceed 8",
    ],
    [
      "an unknown app id",
      [{ id: "editor", executablePath: "/usr/bin/editor" }],
      'desktop app id must be "browser" or "terminal"',
    ],
    [
      "duplicate app ids",
      [
        { id: "terminal", executablePath: "/usr/bin/xfce4-terminal" },
        { id: "terminal", executablePath: "/usr/local/bin/openclaw-worker-terminal" },
      ],
      "desktop app id terminal must be unique",
    ],
    [
      "a relative executable path",
      [{ id: "terminal", executablePath: "bin/xfce4-terminal" }],
      "desktop app executable path must be absolute",
    ],
    [
      "an invalid browser CDP port",
      [
        {
          id: "browser",
          executablePath: "/usr/local/bin/openclaw-worker-browser",
          cdpPort: 65_536,
        },
      ],
      "browser CDP port must be an integer",
    ],
    [
      "an unknown browser field",
      [
        {
          id: "browser",
          executablePath: "/usr/local/bin/openclaw-worker-browser",
          cdpPort: 9222,
          args: ["--headless"],
        },
      ],
      "browser desktop app contains unknown fields",
    ],
    [
      "an unknown terminal field",
      [
        {
          id: "terminal",
          executablePath: "/usr/local/bin/openclaw-worker-terminal",
          env: { DISPLAY: ":99" },
        },
      ],
      "terminal desktop app contains unknown fields",
    ],
  ])("rejects %s", (_name, apps, error) => {
    expect(() =>
      normalizeWorkerDesktopEndpoint({
        protocol: "rfb",
        port: 5900,
        apps,
      } as unknown as WorkerDesktopEndpoint),
    ).toThrow(error);
  });

  it("round-trips desktop metadata and clears it with the provider lease", () => {
    createIntent("worker-desktop");
    store.transition({
      environmentId: "worker-desktop",
      from: "requested",
      to: "provisioning",
    });
    store.transition({
      environmentId: "worker-desktop",
      from: "provisioning",
      to: "bootstrapping",
      patch: { leaseId: "lease-desktop", sshEndpoint: SSH_ENDPOINT, desktop: DESKTOP },
    });
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerEnvironmentStore({ database, now: () => nowMs });
    expect(store.get("worker-desktop")?.desktop).toEqual(DESKTOP);

    const requested = store.requestDestroy({
      environmentId: "worker-desktop",
      state: "bootstrapping",
      terminalState: "failed",
    });
    const draining = store.transition({
      environmentId: requested.environmentId,
      from: requested.state,
      to: "draining",
    });
    const destroying = store.transition({
      environmentId: draining.environmentId,
      from: draining.state,
      to: "destroying",
    });
    expect(
      store.transition({
        environmentId: destroying.environmentId,
        from: destroying.state,
        to: "failed",
        patch: { leaseId: null, sshEndpoint: null, lastError: "teardown complete" },
      }),
    ).toMatchObject({ leaseId: null, sshEndpoint: null, desktop: null });
  });

  it("idempotently ensures desktop_json on an existing state database", () => {
    ensureAdditiveStateColumns(database.db);
    ensureAdditiveStateColumns(database.db);
    const columns = database.db.prepare("PRAGMA table_info(worker_environments)").all() as Array<{
      name: string;
    }>;
    expect(columns.filter((column) => column.name === "desktop_json")).toHaveLength(1);
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

  it("revokes one environment credential without changing lifecycle state", () => {
    const bootstrapping = seedBootstrapping("worker-revocation", "lease-revocation");
    store.transition({
      environmentId: bootstrapping.environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: readyPatch(),
    });
    expect(store.getCredential(bootstrapping.environmentId)).toBeDefined();

    store.revokeEnvironmentCredential(bootstrapping.environmentId);

    expect(store.getCredential(bootstrapping.environmentId)).toBeUndefined();
    expect(store.get(bootstrapping.environmentId)?.state).toBe("ready");
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
    expect(() =>
      store.transition({
        environmentId: "worker-1",
        from: "provisioning",
        to: "ready",
        patch: { leaseId: "lease-1", sshEndpoint: SSH_ENDPOINT },
      }),
    ).toThrow("requires bootstrap proof or a node lease");

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
