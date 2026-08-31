import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import {
  identifiedClient,
  sessionSharingTestContext,
} from "../server-methods/sessions-sharing.test-support.js";
import { resolveSessionMutationAuthorization } from "../session-sharing.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { type PlacementStore, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("worker placement reclaim authority", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;

  const createTestHarness = (options: Parameters<typeof createHarness>[1] = {}) =>
    createHarness(placementStore, { workspacePath: path.join(root, "workspace"), ...options });

  beforeEach(async () => {
    root = tempDirs.make("openclaw-reclaim-auth-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("stops final effects when authority closes during workspace reconciliation", async () => {
    let authorized = true;
    const harness = createTestHarness({
      afterReconcile: () => {
        authorized = false;
      },
    });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim(REQUEST, () => {
        if (!authorized) {
          throw new Error("session recovery authority closed");
        }
      }),
    ).rejects.toThrow("session recovery authority closed");

    expect(harness.log).toContain("workspace:reconcile");
    expect(harness.log).toContain("workspace:resume");
    expect(harness.log).not.toContain("teardown:destroy");
    expect(harness.log).not.toContain("placement:reclaimed");
    expect(harness.environments.destroy).not.toHaveBeenCalled();
    expect(harness.placements.current()).toMatchObject({ state: "draining" });
  });

  it("finishes durable placement completion when authority closes during destroy", async () => {
    let authorized = true;
    const harness = createTestHarness({
      afterDestroy: () => {
        authorized = false;
      },
    });
    await harness.service.dispatch(REQUEST);

    await expect(
      harness.service.reclaim(REQUEST, () => {
        if (!authorized) {
          throw new Error("session recovery authority closed");
        }
      }),
    ).resolves.toMatchObject({ state: "reclaimed" });

    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(harness.placements.current()).toMatchObject({ state: "reclaimed" });
  });

  it("stops failed-placement teardown when authority closes after tunnel cleanup", async () => {
    let authorized = true;
    let revokeAfterStop = false;
    const harness = createTestHarness({
      failAt: "activation",
      destroyFailureCount: 1,
      afterStopTunnel: () => {
        if (revokeAfterStop) {
          authorized = false;
        }
      },
    });
    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow("activation failed");
    expect(harness.placements.current()).toMatchObject({ state: "failed" });

    revokeAfterStop = true;
    await expect(
      harness.service.reclaim(REQUEST, () => {
        if (!authorized) {
          throw new Error("session recovery authority closed");
        }
      }),
    ).rejects.toThrow("session recovery authority closed");

    expect(harness.environments.destroy).toHaveBeenCalledTimes(1);
    expect(harness.placements.current()).toMatchObject({ state: "failed" });
  });

  it("finishes failed-placement bookkeeping when authority closes during destroy", async () => {
    let authorized = true;
    const harness = createTestHarness({
      failAt: "activation",
      destroyFailureCount: 1,
      afterDestroy: () => {
        authorized = false;
      },
    });
    await expect(harness.service.dispatch(REQUEST)).rejects.toThrow("activation failed");
    expect(harness.placements.current()).toMatchObject({ state: "failed" });

    await expect(
      harness.service.reclaim(REQUEST, () => {
        if (!authorized) {
          throw new Error("session recovery authority closed");
        }
      }),
    ).resolves.toMatchObject({ state: "local" });

    expect(harness.environments.destroy).toHaveBeenCalledTimes(2);
    expect(harness.placements.current()).toMatchObject({ state: "local" });
  });
});

describe("worker placement dispatch authority", () => {
  const effects = ["create", "attach", "tunnel:attached", "sync", "placement:starting"];

  it.each([
    { boundary: "readiness", completedEffects: 0 },
    { boundary: "provisioning", completedEffects: 1 },
    { boundary: "attachment", completedEffects: 2 },
    { boundary: "tunnel", completedEffects: 3 },
    { boundary: "workspace sync", completedEffects: 4 },
    { boundary: "activation", completedEffects: 5 },
  ])(
    "stops after membership revocation during $boundary",
    async ({ boundary, completedEffects }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const database = openOpenClawStateDatabase({ env: state.env });
        const store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
        const harness = createHarness(store, { workspacePath: state.workspaceDir });
        const scope = { agentId: REQUEST.agentId, sessionKey: REQUEST.sessionKey };
        const owner = ensureProfileForEmail("dispatch-owner@example.test");
        const member = ensureProfileForEmail("dispatch-member@example.test");
        await upsertSessionEntryCore(scope, {
          sessionId: REQUEST.sessionId,
          updatedAt: 1,
          visibility: "read-only",
          createdActor: { type: "human", source: "profile", id: owner.id },
        });
        addSessionMember(scope, {
          identityId: member.id,
          addedBy: owner.id,
          expectedSessionId: REQUEST.sessionId,
        });
        const result = resolveSessionMutationAuthorization({
          client: identifiedClient(member.id),
          context: sessionSharingTestContext(vi.fn()),
          method: "sessions.dispatch",
          requestParams: { key: REQUEST.sessionKey, deviceId: "device-1" },
        });
        expect(result.error).toBeNull();
        if (!result.authorization) {
          throw new Error("dispatch fixture did not admit its session member");
        }
        const revokeAt = (phase: string) => {
          if (phase === boundary) {
            expect(
              removeSessionMember(scope, member.id, undefined, REQUEST.sessionId),
            ).not.toBeNull();
          }
        };
        const node: NodeWorkerSupervisorNodeProof = {
          nodeId: "device-1",
          connId: "device-connection-1",
          pairingIdentity: "device-identity-1",
          pairingGeneration: "device-pairing-1",
          clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
          clientMode: GATEWAY_CLIENT_MODES.NODE,
          protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
          workerHost: { enabled: true as const, capacity: { total: 2, available: 2 } },
          commands: ["system.run"],
        };
        let readinessObserved = false;
        bindDeviceWorkerAvailability(harness.environments, async () => {
          if (!readinessObserved) {
            readinessObserved = true;
            revokeAt("readiness");
          }
          return { available: true, node };
        });
        const deviceIdentity = {
          providerId: "device",
          profileId: "device:device-1",
          profileSnapshot: { install: "bundle" as const, settings: { device: "device-1" } },
          nodeDeviceId: node.nodeId,
          sshEndpoint: null,
          sharedHost: true,
        };
        const ready = { ...harness.ready, ...deviceIdentity };
        let current: ReturnType<typeof harness.environments.get> = ready;
        vi.mocked(harness.environments.get).mockImplementation(() => current);
        vi.mocked(harness.environments.createFromProfileSnapshot).mockImplementation(async () => {
          harness.log.push("create");
          revokeAt("provisioning");
          return ready;
        });
        const attach = vi.mocked(harness.environments.attachSession).getMockImplementation()!;
        vi.mocked(harness.environments.attachSession).mockImplementation(async (request) => {
          const credential = await attach(request);
          current = { ...harness.attached, ...deviceIdentity };
          revokeAt("attachment");
          return credential;
        });
        const startTunnel = vi.mocked(harness.environments.startTunnel).getMockImplementation()!;
        vi.mocked(harness.environments.startTunnel).mockImplementation(async (request) => {
          const tunnel = await startTunnel(request);
          const sync = tunnel.syncWorkspace.bind(tunnel);
          tunnel.syncWorkspace = async (syncRequest) => {
            const synced = await sync(syncRequest);
            revokeAt("workspace sync");
            return synced;
          };
          revokeAt("tunnel");
          return tunnel;
        });
        const destroy = vi.mocked(harness.environments.destroy).getMockImplementation()!;
        vi.mocked(harness.environments.destroy).mockImplementation(async (environmentId) => {
          current = await destroy(environmentId);
          return current;
        });

        await expect(
          harness.service.dispatch(
            {
              ...REQUEST,
              profileId: deviceIdentity.profileId,
              deviceId: node.nodeId,
              devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
              inheritedProfile: {
                providerId: deviceIdentity.providerId,
                profileSnapshot: deviceIdentity.profileSnapshot,
              },
            },
            (placement) => {
              if (placement.state === "starting") {
                revokeAt("activation");
              }
            },
            result.authorization.assertCurrent,
          ),
        ).rejects.toMatchObject({
          error: { details: { code: "SESSION_PARTICIPATION_REQUIRED" } },
        });

        expect(harness.log.filter((event) => effects.includes(event))).toEqual(
          effects.slice(0, completedEffects),
        );
        expect(harness.log).not.toContain("placement:active");
        expect(harness.environments.destroy).toHaveBeenCalledTimes(completedEffects === 0 ? 0 : 1);
        expect(store.get(REQUEST.sessionId)).toMatchObject({ state: "failed", turnClaim: null });
      });
    },
  );
});
