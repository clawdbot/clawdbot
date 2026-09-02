// Process-local placement-grant retention and final-boundary revalidation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../infra/plugin-approval-canonical-decisions.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { applyPluginNodeInvokePolicy } from "./node-invoke-plugin-policy.js";
import {
  createApprovalClientLookup,
  createContext,
  createDemoPolicy,
  createNodeSession,
  createOperatorClient,
  DEMO_COMMAND,
  DEMO_PARAMS,
  expectSinglePendingApproval,
  setDangerousDemoCommandRegistry,
} from "./node-invoke-plugin-policy.test-helpers.js";
import {
  createPlacementStandingGrantRuntime,
  type PlacementStandingGrantMintSpec,
} from "./operator-approval-placement-grants.js";
import { insertOperatorApproval, resolveOperatorApproval } from "./operator-approval-store.js";

type PlacementTestDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "operator_approvals" | "worker_environments" | "worker_session_placements"
>;
type NewOperatorApproval = Parameters<typeof insertOperatorApproval>[0]["approval"];

const NOW_MS = 1_756_000_000_000;
const SESSION_ID = "session-placement-1";
const SESSION_KEY = "agent:main:placement-1";
const ENVIRONMENT_ID = "environment-1";
const NODE_ID = "node-1";
const PAIRING_GENERATION = "pairing-1";
const CWD = "/worker/workspace";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = tempDirs.make("openclaw-placement-grant-");
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

beforeEach(resetPluginRuntimeStateForTest);

afterEach(() => {
  resetPluginRuntimeStateForTest();
  closeOpenClawStateDatabaseForTest();
});

function seedActivePlacement(databaseOptions: OpenClawStateDatabaseOptions): void {
  const database = openOpenClawStateDatabase(databaseOptions);
  const stateDb = getNodeSqliteKysely<PlacementTestDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    stateDb.insertInto("worker_environments").values({
      environment_id: ENVIRONMENT_ID,
      provider_id: "test-provider",
      profile_id: "test-profile",
      profile_snapshot_json: "{}",
      provision_operation_id: "provision-1",
      lease_id: "lease-1",
      node_setup_id: "setup-1",
      node_device_id: NODE_ID,
      ssh_host: null,
      ssh_port: null,
      ssh_user: null,
      ssh_host_key: null,
      ssh_key_ref_json: null,
      desktop_json: null,
      state: "attached",
      bootstrap_bundle_hash: "bundle-1",
      bootstrap_openclaw_version: "test",
      bootstrap_protocol_features_json: "[]",
      bootstrap_install_kind: "test",
      owner_epoch: 7,
      teardown_terminal_state: null,
      attached_session_ids_json: JSON.stringify([SESSION_ID]),
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      state_changed_at_ms: NOW_MS,
      idle_since_at_ms: null,
      destroy_requested_at_ms: null,
      last_error: null,
      shared_host: 0,
    }),
  );
  executeSqliteQuerySync(
    database.db,
    stateDb.insertInto("worker_session_placements").values({
      session_id: SESSION_ID,
      agent_id: "main",
      session_key: SESSION_KEY,
      execution_mode: "remote-exec",
      state: "active",
      environment_id: ENVIRONMENT_ID,
      transition_generation: 4,
      active_owner_epoch: 7,
      workspace_base_manifest_ref: "manifest-1",
      remote_workspace_dir: CWD,
      worker_bundle_hash: "bundle-1",
      last_transcript_ack_cursor: null,
      last_live_event_ack_cursor: null,
      recovery_error: null,
      terminal_reason: null,
      terminal_at_ms: null,
      turn_claim_owner: null,
      turn_claim_id: null,
      turn_claim_run_id: null,
      turn_claim_generation: null,
      turn_claim_owner_epoch: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      state_changed_at_ms: NOW_MS,
    }),
  );
}

function approval(id: string): NewOperatorApproval {
  return {
    id,
    kind: "plugin",
    presentation: {
      kind: "plugin",
      title: "Run Codex on this node placement",
      description: "Run Codex on the active placement.",
      severity: "critical",
      pluginId: "codex",
      toolName: null,
      agentId: "main",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    requester: { deviceId: "device-1", clientId: "client-1", deviceTokenAuth: true },
    reviewerDeviceIds: [],
    source: {
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      runId: "run-1",
      toolCallId: null,
      toolName: "codex.exec-server.stdio.v2",
    },
    audienceSessionKeys: [],
    runtimeEpoch: "runtime-1",
    createdAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 60_000,
  };
}

function resolveBinding(
  databaseOptions: OpenClawStateDatabaseOptions,
  runtime = createPlacementStandingGrantRuntime({
    runtimeEpoch: "runtime-1",
    databaseOptions,
    now: () => NOW_MS + 2_000,
  }),
): PlacementStandingGrantMintSpec {
  const binding = runtime.resolveBinding({
    pluginId: "codex",
    command: "codex.exec-server.stdio.v2",
    approvalScope: "codex.exec-server",
    agentId: "main",
    sessionKey: SESSION_KEY,
    nodeId: NODE_ID,
    pairingGeneration: PAIRING_GENERATION,
  });
  expect(binding).not.toBeNull();
  return binding!;
}

function mintGrant(
  databaseOptions: OpenClawStateDatabaseOptions,
  now: () => number = () => NOW_MS + 2_000,
): {
  binding: PlacementStandingGrantMintSpec;
  runtime: ReturnType<typeof createPlacementStandingGrantRuntime>;
} {
  seedActivePlacement(databaseOptions);
  const runtime = createPlacementStandingGrantRuntime({
    runtimeEpoch: "runtime-1",
    databaseOptions,
    now,
  });
  const binding = resolveBinding(databaseOptions, runtime);
  insertOperatorApproval({ approval: approval("approval-1"), databaseOptions });
  expect(
    resolveOperatorApproval({
      id: "approval-1",
      decision: "allow-always",
      resolver: { kind: "device", id: "reviewer-1" },
      nowMs: NOW_MS + 1_000,
      databaseOptions,
    }).outcome,
  ).toBe("resolved");
  expect(
    runtime.retain({
      ...binding,
      approvalId: "approval-1",
      nowMs: NOW_MS + 1_000,
      expiresAtMs: null,
    }),
  ).toBe(true);
  return { binding, runtime };
}

describe("placement standing grants", () => {
  it("retains the exact binding only for the current Gateway runtime", () => {
    const databaseOptions = createDatabaseOptions();
    seedActivePlacement(databaseOptions);
    const database = openOpenClawStateDatabase(databaseOptions);
    const versionBefore = database.db.prepare("PRAGMA user_version").get();
    const metadataBefore = database.db
      .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
      .get();
    expect(tableExists(database.db, "operator_approval_placement_grants")).toBe(false);

    const runtime = createPlacementStandingGrantRuntime({
      runtimeEpoch: "runtime-1",
      databaseOptions,
      now: () => NOW_MS + 2_000,
    });
    const binding = resolveBinding(databaseOptions, runtime);
    expect(binding).toEqual({
      pluginId: "codex",
      command: "codex.exec-server.stdio.v2",
      approvalScope: "codex.exec-server",
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      pairingGeneration: PAIRING_GENERATION,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: 7,
      placementGeneration: 4,
      cwd: CWD,
    });
    insertOperatorApproval({ approval: approval("approval-1"), databaseOptions });
    expect(
      resolveOperatorApproval({
        id: "approval-1",
        decision: "allow-always",
        resolver: { kind: "device", id: "reviewer-1" },
        nowMs: NOW_MS + 1_000,
        databaseOptions,
      }).outcome,
    ).toBe("resolved");
    expect(
      runtime.retain({
        ...binding,
        approvalId: "approval-1",
        nowMs: NOW_MS + 1_000,
        expiresAtMs: null,
      }),
    ).toBe(true);

    expect(runtime.validate(binding)).toMatchObject({
      outcome: "consumed",
      grant: { mintedByApprovalId: "approval-1" },
    });
    expect(runtime.consume(binding).outcome).toBe("consumed");
    expect(tableExists(database.db, "operator_approval_placement_grants")).toBe(false);
    expect(
      createPlacementStandingGrantRuntime({
        runtimeEpoch: "runtime-1",
        databaseOptions,
        now: () => NOW_MS + 2_000,
      }).validate(binding).outcome,
    ).toBe("no-grant");
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual(versionBefore);
    expect(
      database.db
        .prepare("SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual(metadataBefore);
  });

  it("does not retain a grant before the parent allow-always decision", () => {
    const databaseOptions = createDatabaseOptions();
    seedActivePlacement(databaseOptions);
    const runtime = createPlacementStandingGrantRuntime({
      runtimeEpoch: "runtime-1",
      databaseOptions,
      now: () => NOW_MS + 2_000,
    });
    const binding = resolveBinding(databaseOptions, runtime);
    insertOperatorApproval({ approval: approval("approval-1"), databaseOptions });
    expect(
      runtime.retain({
        ...binding,
        approvalId: "approval-1",
        nowMs: NOW_MS + 1_000,
        expiresAtMs: null,
      }),
    ).toBe(false);
    expect(runtime.validate(binding).outcome).toBe("no-grant");
  });

  it("keeps operation families isolated", () => {
    const databaseOptions = createDatabaseOptions();
    const { binding, runtime } = mintGrant(databaseOptions);
    expect(
      runtime.validate({
        ...binding,
        command: "another.dangerous.command",
      }).outcome,
    ).toBe("no-grant");
  });

  it.each([
    {
      name: "node substitution",
      expected: "node-changed",
      change: (binding: PlacementStandingGrantMintSpec) => ({ ...binding, nodeId: "node-2" }),
    },
    {
      name: "device re-pair",
      expected: "pairing-changed",
      change: (binding: PlacementStandingGrantMintSpec) => ({
        ...binding,
        pairingGeneration: "pairing-2",
      }),
    },
  ])("fails closed after $name", ({ expected, change }) => {
    const databaseOptions = createDatabaseOptions();
    const { binding, runtime } = mintGrant(databaseOptions);
    expect(runtime.consume(change(binding)).outcome).toBe(expected);
  });

  it.each([
    ["placement generation bump", { transition_generation: 5 }],
    ["gateway owner-epoch rotation", { active_owner_epoch: 8 }],
    ["placement drain", { state: "draining" }],
  ] as const)("fails closed after %s", (_name, update) => {
    const databaseOptions = createDatabaseOptions();
    const { binding, runtime } = mintGrant(databaseOptions);
    const database = openOpenClawStateDatabase(databaseOptions);
    const stateDb = getNodeSqliteKysely<PlacementTestDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("worker_session_placements")
        .set(update)
        .where("session_id", "=", SESSION_ID),
    );
    expect(runtime.consume(binding).outcome).toBe("placement-changed");
  });

  it("fails closed after expiry, parent removal or reversal, or placement removal", () => {
    const scenarios = ["expired", "parent-missing", "parent", "placement"] as const;
    for (const scenario of scenarios) {
      let nowMs = NOW_MS + 2_000;
      const databaseOptions = createDatabaseOptions();
      const { binding, runtime } = mintGrant(databaseOptions, () => nowMs);
      const database = openOpenClawStateDatabase(databaseOptions);
      const stateDb = getNodeSqliteKysely<PlacementTestDatabase>(database.db);
      if (scenario === "parent-missing") {
        executeSqliteQuerySync(
          database.db,
          stateDb.deleteFrom("operator_approvals").where("approval_id", "=", "approval-1"),
        );
      } else if (scenario === "parent") {
        executeSqliteQuerySync(
          database.db,
          stateDb
            .updateTable("operator_approvals")
            .set({ status: "denied", decision: "deny" })
            .where("approval_id", "=", "approval-1"),
        );
      } else if (scenario === "placement") {
        executeSqliteQuerySync(database.db, stateDb.deleteFrom("worker_session_placements"));
      }
      if (scenario === "expired") {
        nowMs = NOW_MS + 31 * 24 * 60 * 60_000;
      }
      expect(runtime.consume(binding).outcome).toBe(
        scenario === "expired"
          ? "expired"
          : scenario === "parent-missing"
            ? "approval-missing"
            : scenario === "parent"
              ? "approval-not-allow-always"
              : "placement-missing",
      );
      closeOpenClawStateDatabaseForTest();
    }
  });

  it("skips the second launch and re-prompts after the placement generation changes", async () => {
    const databaseOptions = createDatabaseOptions();
    seedActivePlacement(databaseOptions);
    const placementStandingGrants = createPlacementStandingGrantRuntime({
      runtimeEpoch: "placement-policy-test",
      databaseOptions,
    });
    const manager = new ExecApprovalManager<PluginApprovalRequestPayload>({
      approvalKind: "plugin",
      persistence: { runtimeEpoch: "placement-policy-test", databaseOptions },
      resolveAllowedDecisions: resolveCanonicalPluginApprovalRequestAllowedDecisions,
      resolveStandingGrantMint: (request) =>
        request.placementGrant ? { kind: "placement", ...request.placementGrant } : null,
      retainPlacementStandingGrant: placementStandingGrants.retain,
      validateAgentRuntimeDelegatedAuthority: () => true,
    });
    const policy = createDemoPolicy(async (context) => {
      const placementApproval = await context.approvals?.request({
        title: "Run on placement",
        description: "Allow this exact active placement.",
        allowedDecisions: ["allow-once", "allow-always"],
      });
      if (
        placementApproval?.decision !== "allow-once" &&
        placementApproval?.decision !== "allow-always"
      ) {
        return { ok: false, code: "DENIED", message: "approval denied" };
      }
      return await context.invokeNode();
    });
    policy.policy.classifyRisk = () => ({ level: "high", family: "demo.exec" });
    setDangerousDemoCommandRegistry([policy]);

    const nodeSession = { ...createNodeSession(), pairingGeneration: PAIRING_GENERATION };
    const { context } = createContext({
      pluginApprovalManager: manager,
      nodeSession,
      getApprovalClientConnIds: createApprovalClientLookup([createOperatorClient("reviewer")]),
      validateAgentRuntimeApprovalAuthority: () => true,
    });
    context.placementStandingGrants = placementStandingGrants;
    const invoke = vi.fn(async (input: Parameters<typeof context.nodeRegistry.invoke>[0]) => {
      if (input.isDispatchAuthorized?.() === false) {
        return {
          ok: false,
          payload: null,
          payloadJSON: null,
          error: { code: "AUTHORIZATION_CLOSED", message: "authorization closed" },
        };
      }
      input.onDispatchReady?.("invoke-placement");
      return { ok: true, payload: { connected: true }, payloadJSON: null, error: null };
    });
    context.nodeRegistry.invoke = invoke;
    const client = createOperatorClient();
    let placementAuthorityActive = true;
    const nodePlacementGrantAuthority = {
      agentId: "main",
      sessionKey: SESSION_KEY,
      runId: "run-placement-policy",
      assertCurrent: () => {
        if (!placementAuthorityActive) {
          throw new Error("placement authority closed");
        }
      },
    };
    const operationalRunInstance = createOperationalRunInstanceRef("identity-only-placement");
    const identityOnlyLaunch = applyPluginNodeInvokePolicy({
      context,
      client: {
        ...client,
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: SESSION_KEY,
            operationalRunInstance,
            delegatedAuthority: {
              kind: "local",
              operationalRunInstance,
              lifecycleGeneration: "identity-only-generation",
              claimId: "identity-only-claim",
            },
          },
        },
      },
      nodeSession,
      command: DEMO_COMMAND,
      params: DEMO_PARAMS,
      sessionKey: SESSION_KEY,
    });
    const identityOnlyApproval = await expectSinglePendingApproval(manager);
    expect(identityOnlyApproval.request.allowedDecisions).not.toContain("allow-always");
    expect(identityOnlyApproval.request.placementGrant).toBeNull();
    expect(manager.resolve(identityOnlyApproval.id, "deny")).toBe(true);
    await expect(identityOnlyLaunch).resolves.toMatchObject({ ok: false, code: "DENIED" });

    const launch = () =>
      withPluginRuntimeGatewayRequestScope(
        { isWebchatConnect: () => false, nodePlacementGrantAuthority },
        () =>
          applyPluginNodeInvokePolicy({
            context,
            client,
            nodeSession,
            command: DEMO_COMMAND,
            params: DEMO_PARAMS,
            sessionKey: SESSION_KEY,
          }),
      );

    const legacyLaunch = launch();
    const legacyApproval = await expectSinglePendingApproval(manager);
    expect(legacyApproval.request.allowedDecisions).not.toContain("allow-always");
    expect(legacyApproval.request.placementGrant).toBeNull();
    expect(manager.resolve(legacyApproval.id, "deny")).toBe(true);
    await expect(legacyLaunch).resolves.toMatchObject({ ok: false, code: "DENIED" });

    policy.policy.standingApproval = { kind: "placement", scope: "demo.exec-placement" };
    const firstLaunch = launch();
    const firstApproval = await expectSinglePendingApproval(manager);
    expect(firstApproval.request.placementGrant).toMatchObject({
      sessionId: SESSION_ID,
      nodeId: NODE_ID,
      approvalScope: "demo.exec-placement",
      placementGeneration: 4,
    });
    expect(manager.resolve(firstApproval.id, "allow-always")).toBe(true);
    await expect(firstLaunch).resolves.toMatchObject({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(1);

    await expect(launch()).resolves.toMatchObject({ ok: true });
    expect(manager.listPendingRecords()).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(2);

    const database = openOpenClawStateDatabase(databaseOptions);
    const stateDb = getNodeSqliteKysely<PlacementTestDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("worker_session_placements")
        .set({ transition_generation: 5 })
        .where("session_id", "=", SESSION_ID),
    );
    const staleLaunch = launch();
    const staleApproval = await expectSinglePendingApproval(manager);
    placementAuthorityActive = false;
    expect(manager.resolve(staleApproval.id, "allow-always")).toBe(false);
    await expect(staleLaunch).resolves.toMatchObject({ ok: false, code: "DENIED" });
    placementAuthorityActive = true;

    const movedLaunch = launch();
    const movedApproval = await expectSinglePendingApproval(manager);
    expect(movedApproval.id).not.toBe(firstApproval.id);
    expect(movedApproval.request.placementGrant).toMatchObject({ placementGeneration: 5 });
    expect(manager.resolve(movedApproval.id, "deny")).toBe(true);
    await expect(movedLaunch).resolves.toMatchObject({ ok: false, code: "DENIED" });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
