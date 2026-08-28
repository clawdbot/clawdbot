import fs from "node:fs/promises";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../../../src/infra/kysely-sync.js";
import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_WORKSPACE_RETAIN_COMMAND,
} from "../../../../src/infra/node-commands.js";
import { withOpenClawStateDatabaseReadOnly } from "../../../../src/state/openclaw-state-db-readonly.js";
import type { DB as StateDatabase } from "../../../../src/state/openclaw-state-db.generated.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import { startPairedNodeWorkerLifecycleProvider } from "./paired-node-worker-lifecycle-provider.js";
import {
  bundleInstallFrames,
  closeWireServer,
  connectWireClient,
  createPairedNodeWorkerHost,
  createPublishedWireWorkspace,
  startPairedNodeWorkerGateway,
  type PairedNodeWorkerHost,
  type PublishedWireWorkspace,
  type WireGateway,
  type WireNodeRead,
  wireMessageText,
} from "./paired-node-worker-wire-fixture.js";

const TEST_TIMEOUT_MS = PROOF_TIMEOUT_MS + 180_000;
const SESSION_PREFIX = "agent:qa:paired-node-worker-lifecycle";
const HOLD_A = "WIRE-HOLD-A";
const HOLD_B = "WIRE-HOLD-B";

type TurnResult = { runId?: string; status?: string; summary?: string };
type Placement = {
  activeOwnerEpoch?: number;
  environmentId?: string;
  generation?: number;
  recoveryError?: string;
  state?: string;
  workerBundleHash?: string;
};
type EnvironmentRead = {
  id: string;
  type: string;
  workerBundle?: WireNodeRead["workerBundle"];
  worker?: { state?: string; attachedSessionIds?: string[]; tunnelStatus?: string };
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createSession(params: {
  operator: GatewayClient;
  published: PublishedWireWorkspace;
  suffix: string;
}): Promise<string> {
  const key = `${SESSION_PREFIX}:${params.suffix}`;
  await params.operator.request("sessions.create", {
    key,
    agentId: "qa",
    worktree: true,
    worktreeName: `paired-node-${params.suffix}`,
    worktreeBaseRef: "main",
    cwd: params.published.source,
  });
  return key;
}

async function dispatchNodeSession(params: {
  gateway: WireGateway;
  key: string;
  nodeId: string;
}): Promise<Placement> {
  const result = (await params.gateway.call(
    "sessions.dispatch",
    { key: params.key, deviceId: params.nodeId },
    { timeoutMs: PROOF_TIMEOUT_MS },
  )) as { placement?: Placement };
  expect(result.placement).toMatchObject({ state: "active" });
  return result.placement!;
}

async function startTurn(params: {
  operator: GatewayClient;
  key: string;
  marker: string;
}): Promise<string> {
  const runId = `${params.marker.toLowerCase()}-${Date.now()}`;
  const started = await params.operator.request<TurnResult>("chat.send", {
    sessionKey: params.key,
    message: `Reply exactly: ${params.marker}`,
    deliver: false,
    idempotencyKey: runId,
  });
  expect(started).toMatchObject({ runId, status: "started" });
  return runId;
}

async function waitForTurn(operator: GatewayClient, runId: string): Promise<TurnResult> {
  return await operator.request<TurnResult>(
    "agent.wait",
    { runId, timeoutMs: PROOF_TIMEOUT_MS },
    { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
  );
}

async function expectSuccessfulTurn(params: {
  operator: GatewayClient;
  key: string;
  marker: string;
}): Promise<void> {
  const runId = await startTurn(params);
  await expect(waitForTurn(params.operator, runId)).resolves.toMatchObject({ status: "ok" });
  await vi.waitFor(
    async () => {
      const history = await params.operator.request<{ messages?: unknown[] }>("chat.history", {
        sessionKey: params.key,
        limit: 100,
      });
      expect(
        history.messages?.some(
          (message) =>
            (message as { role?: unknown }).role === "assistant" &&
            wireMessageText(message).includes(params.marker),
        ),
      ).toBe(true);
    },
    { timeout: 30_000, interval: 100 },
  );
}

async function describePlacement(gateway: WireGateway, key: string): Promise<Placement> {
  const described = (await gateway.call("sessions.describe", { key })) as {
    session?: { placement?: Placement };
  };
  return described.session?.placement ?? {};
}

async function readNode(
  operator: GatewayClient,
  nodeId: string,
): Promise<WireNodeRead | undefined> {
  const result = await operator.request<{ nodes?: WireNodeRead[] }>("node.list", {});
  return result.nodes?.find((node) => node.nodeId === nodeId);
}

async function readEnvironments(operator: GatewayClient): Promise<EnvironmentRead[]> {
  const result = await operator.request<{ environments?: EnvironmentRead[] }>(
    "environments.list",
    {},
  );
  return result.environments ?? [];
}

async function expectPublicBundleStatus(params: {
  operator: GatewayClient;
  nodeId: string;
  status: "installed" | "missing";
}): Promise<void> {
  await vi.waitFor(
    async () => {
      const node = await readNode(params.operator, params.nodeId);
      const environment = (await readEnvironments(params.operator)).find(
        (entry) => entry.id === `node:${params.nodeId}`,
      );
      expect(node?.workerBundle?.status).toBe(params.status);
      expect(environment?.workerBundle?.status).toBe(params.status);
      for (const projection of [node?.workerBundle, environment?.workerBundle]) {
        expect(Object.keys(projection ?? {}).toSorted()).toEqual(
          params.status === "installed" ? ["status", "version"] : ["status"],
        );
        expect(projection).not.toHaveProperty("bundleHash");
        expect(projection).not.toHaveProperty("path");
      }
    },
    { timeout: 30_000, interval: 100 },
  );
}

describe("paired node worker lifecycle wire", () => {
  it(
    "keeps local control usable across bundle loss, disconnect, capacity, and role removal",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const root = tempDirs.make("openclaw-paired-node-worker-lifecycle-");
      const provider = await startPairedNodeWorkerLifecycleProvider([HOLD_A, HOLD_B]);
      const published = await createPublishedWireWorkspace(root);
      let gateway: WireGateway | undefined;
      let operator: GatewayClient | undefined;
      let workerNode: PairedNodeWorkerHost | undefined;
      let testFailure: { error: unknown } | undefined;
      let cleanupFailures: unknown[];
      try {
        gateway = await startPairedNodeWorkerGateway({ providerBaseUrl: provider.baseUrl });
        operator = await connectWireClient({ gateway, role: "operator", identity: null });
        workerNode = await createPairedNodeWorkerHost({
          gateway,
          operator,
          root,
          capacity: 2,
          capacityWaitMs: 750,
          bundlePrewarm: true,
          bundleRetention: true,
          bundleStatus: true,
        });
        const nodeId = workerNode.identity.deviceId;
        const localKey = await createSession({ operator, published, suffix: "local-control" });
        const retainedKey = await createSession({ operator, published, suffix: "retention" });
        const retainedPlacement = await dispatchNodeSession({
          gateway,
          key: retainedKey,
          nodeId,
        });
        const bundleHash = retainedPlacement.workerBundleHash;
        expect(bundleHash).toMatch(/^[a-f0-9]{64}$/u);

        // Local and node-placed sessions share the Gateway without sharing failure state.
        await expectSuccessfulTurn({ operator, key: retainedKey, marker: "WIRE-NODE-BASELINE" });
        await expectSuccessfulTurn({ operator, key: localKey, marker: "WIRE-LOCAL-BASELINE" });

        // Stop-and-continue moves reconcile the source before returning local, never pass through
        // reclaimed, and the same session can dispatch back to its paired node afterward.
        const sourcePlacement = await describePlacement(gateway, retainedKey);
        expect(sourcePlacement).toMatchObject({
          state: "active",
          environmentId: retainedPlacement.environmentId,
          generation: expect.any(Number),
          activeOwnerEpoch: expect.any(Number),
        });
        if (
          typeof sourcePlacement.generation !== "number" ||
          typeof sourcePlacement.environmentId !== "string" ||
          typeof sourcePlacement.activeOwnerEpoch !== "number"
        ) {
          throw new Error("active placement did not expose exact move source facts");
        }
        const movedLocal = (await gateway.call(
          "sessions.move",
          {
            key: retainedKey,
            expected: {
              generation: sourcePlacement.generation,
              environmentId: sourcePlacement.environmentId,
              ownerEpoch: sourcePlacement.activeOwnerEpoch,
            },
            target: { kind: "gateway" },
          },
          { timeoutMs: PROOF_TIMEOUT_MS },
        )) as { placement?: Placement };
        expect(movedLocal.placement).toMatchObject({ state: "local" });
        expect(await describePlacement(gateway, retainedKey)).toMatchObject({ state: "local" });
        await workerNode.waitForInvokes();
        expect(
          workerNode.frames
            .filter((frame) => frame.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND)
            .map((frame) => JSON.parse(frame.paramsJSON!)),
        ).toContainEqual(
          expect.objectContaining({
            environmentId: sourcePlacement.environmentId,
            ownerEpoch: sourcePlacement.activeOwnerEpoch,
          }),
        );
        await expectSuccessfulTurn({ operator, key: retainedKey, marker: "WIRE-MOVED-LOCAL" });
        await dispatchNodeSession({ gateway, key: retainedKey, nodeId });
        await expectSuccessfulTurn({ operator, key: retainedKey, marker: "WIRE-MOVED-BACK" });

        // Bundle maintenance reports only the public status/version projection and repairs loss.
        await expectPublicBundleStatus({ operator, nodeId, status: "installed" });
        const installedBundle = await workerNode.installedBundleDirectory(bundleHash!);
        const installCountBeforeLoss = bundleInstallFrames(workerNode).length;
        await fs.rm(installedBundle, { recursive: true, force: true });
        await workerNode.disconnect();
        await workerNode.connect();
        await expectPublicBundleStatus({ operator, nodeId, status: "missing" });
        expect(
          workerNode.commands.filter((command) => command === NODE_WORKER_WORKSPACE_RETAIN_COMMAND)
            .length,
        ).toBeGreaterThan(0);
        await expectSuccessfulTurn({ operator, key: localKey, marker: "WIRE-LOCAL-AFTER-LOSS" });

        const repairedKey = await createSession({ operator, published, suffix: "reinstalled" });
        await dispatchNodeSession({ gateway, key: repairedKey, nodeId });
        await vi.waitFor(
          () => expect(bundleInstallFrames(workerNode!).length).toBe(installCountBeforeLoss + 1),
          { timeout: 30_000, interval: 100 },
        );
        await expectPublicBundleStatus({ operator, nodeId, status: "installed" });

        // An offline runner fails before handoff, leaves the active placement retryable, and
        // does not terminalize the independent local session.
        await workerNode.disconnect();
        const offlineRunId = await startTurn({
          operator,
          key: repairedKey,
          marker: "WIRE-OFFLINE-ATTEMPT",
        });
        const offline = await waitForTurn(operator, offlineRunId);
        expect(offline.status).not.toBe("ok");
        expect(`${offline.summary ?? ""} ${JSON.stringify(offline)}`).toMatch(
          /runner-offline|runner is offline|reconnect/iu,
        );
        expect(await describePlacement(gateway, repairedKey)).toMatchObject({ state: "active" });
        await expectSuccessfulTurn({ operator, key: localKey, marker: "WIRE-LOCAL-AFTER-OFFLINE" });
        await workerNode.connect();
        await expectSuccessfulTurn({ operator, key: repairedKey, marker: "WIRE-OFFLINE-RETRY" });
        await workerNode.waitForWorkersIdle();

        // Two nonterminal real worker children consume both physical slots. The third turn
        // records a bounded capacity failure at the public RPC/history/placement boundaries.
        const holdAKey = await createSession({ operator, published, suffix: "capacity-a" });
        const holdBKey = await createSession({ operator, published, suffix: "capacity-b" });
        const capacityKey = await createSession({ operator, published, suffix: "capacity-c" });
        await dispatchNodeSession({ gateway, key: holdAKey, nodeId });
        await dispatchNodeSession({ gateway, key: holdBKey, nodeId });
        await dispatchNodeSession({ gateway, key: capacityKey, nodeId });
        const holdARunId = await startTurn({ operator, key: holdAKey, marker: HOLD_A });
        const holdBRunId = await startTurn({ operator, key: holdBKey, marker: HOLD_B });
        await vi.waitFor(
          () => {
            expect(provider.hasHeld(HOLD_A)).toBe(true);
            expect(provider.hasHeld(HOLD_B)).toBe(true);
          },
          { timeout: 30_000, interval: 100 },
        );
        const capacityRunId = await startTurn({
          operator,
          key: capacityKey,
          marker: "WIRE-CAPACITY-ATTEMPT",
        });
        const capacity = await waitForTurn(operator, capacityRunId);
        expect(capacity.status).not.toBe("ok");
        expect(`${capacity.summary ?? ""} ${JSON.stringify(capacity)}`).toMatch(/capacity/iu);
        expect(await describePlacement(gateway, capacityKey)).toMatchObject({ state: "active" });
        await vi.waitFor(
          async () => {
            const history = await operator!.request<{ messages?: unknown[] }>("chat.history", {
              sessionKey: capacityKey,
              limit: 100,
            });
            const messages = history.messages ?? [];
            expect(
              messages.some(
                (message) =>
                  (message as { role?: unknown }).role === "user" &&
                  wireMessageText(message).includes("WIRE-CAPACITY-ATTEMPT"),
              ),
            ).toBe(true);
            expect(
              messages.some(
                (message) =>
                  (message as { role?: unknown }).role === "assistant" &&
                  wireMessageText(message).includes("WIRE-CAPACITY-ATTEMPT"),
              ),
            ).toBe(false);
          },
          { timeout: 30_000, interval: 100 },
        );
        await expectSuccessfulTurn({ operator, key: localKey, marker: "WIRE-LOCAL-AT-CAPACITY" });
        provider.release(HOLD_A);
        await expect(waitForTurn(operator, holdARunId)).resolves.toMatchObject({ status: "ok" });
        await expectSuccessfulTurn({
          operator,
          key: capacityKey,
          marker: "WIRE-CAPACITY-RETRY",
        });
        provider.release(HOLD_B);
        await expect(waitForTurn(operator, holdBRunId)).resolves.toMatchObject({ status: "ok" });

        // Revocation fences placement before responding but cannot prove remote extinction.
        // Keep the exact attachment pending cleanup rather than invent a terminal environment.
        const removalKey = await createSession({ operator, published, suffix: "role-removal" });
        const removalPlacement = await dispatchNodeSession({ gateway, key: removalKey, nodeId });
        const removalEnvironment = (await readEnvironments(operator)).find(
          (entry) => entry.id === removalPlacement.environmentId,
        );
        const attachedSessionIds = removalEnvironment?.worker?.attachedSessionIds;
        if (
          !removalPlacement.environmentId ||
          typeof removalPlacement.activeOwnerEpoch !== "number" ||
          attachedSessionIds?.length !== 1
        ) {
          throw new Error("role-removal placement did not expose exact ownership");
        }
        const removalEnvironmentId = removalPlacement.environmentId;
        expect(workerNode.client).toBeTruthy();
        await expect(operator.request("node.pair.remove", { nodeId })).resolves.toMatchObject({
          nodeId,
        });
        const removedEnvironment = (await readEnvironments(operator)).find(
          (entry) => entry.id === removalPlacement.environmentId,
        );
        expect(removedEnvironment?.worker).toMatchObject({
          state: "attached",
          attachedSessionIds,
          tunnelStatus: "stopped",
        });
        withOpenClawStateDatabaseReadOnly(
          ({ db }) => {
            const query = getNodeSqliteKysely<StateDatabase>(db);
            expect(
              executeSqliteQueryTakeFirstSync(
                db,
                query
                  .selectFrom("worker_environments")
                  .select([
                    "owner_epoch",
                    "attached_session_ids_json",
                    "destroy_requested_at_ms",
                    "teardown_terminal_state",
                    "last_error",
                  ])
                  .where("environment_id", "=", removalEnvironmentId),
              ),
            ).toMatchObject({
              owner_epoch: removalPlacement.activeOwnerEpoch,
              attached_session_ids_json: JSON.stringify(attachedSessionIds),
              destroy_requested_at_ms: expect.any(Number),
              teardown_terminal_state: "failed",
              last_error: "Worker provider no longer recognizes the lease",
            });
            expect(
              executeSqliteQueryTakeFirstSync(
                db,
                query
                  .selectFrom("worker_environment_credentials")
                  .select("environment_id")
                  .where("environment_id", "=", removalEnvironmentId),
              ),
            ).toBeUndefined();
          },
          { env: gateway.runtimeEnv },
        );
        expect(await describePlacement(gateway, removalKey)).toMatchObject({
          state: "failed",
          recoveryError: expect.stringContaining("not connected"),
        });
        await expect(workerNode.publishInventory()).rejects.toBeTruthy();
        await vi.waitFor(
          async () => {
            const node = await readNode(operator!, nodeId);
            expect(node?.connected).not.toBe(true);
          },
          { timeout: 30_000, interval: 100 },
        );
        await expectSuccessfulTurn({ operator, key: localKey, marker: "WIRE-LOCAL-AFTER-REMOVAL" });
        await workerNode.waitForInvokes();
        expect(workerNode.invokeErrors).toEqual([]);
      } catch (error) {
        testFailure = { error };
      } finally {
        provider.releaseAll();
        const cleanup = await Promise.allSettled([
          workerNode?.stop() ?? Promise.resolve(),
          operator?.stopAndWait({ timeoutMs: 2_000 }) ?? Promise.resolve(),
          gateway?.stop() ?? Promise.resolve(),
          provider.stop(),
          closeWireServer(published.server),
        ]);
        cleanupFailures = cleanup.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
      }
      const failures = [...(testFailure ? [testFailure.error] : []), ...cleanupFailures];
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "paired node worker lifecycle test failed");
      }
    },
  );
});
