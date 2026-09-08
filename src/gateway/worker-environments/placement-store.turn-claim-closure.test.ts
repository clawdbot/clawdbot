import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { tryBeginGatewayRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { projectSessionMessagePayload } from "../session-transcript-message.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { placementTurnOwner, type WorkerSessionPlacementIdentity } from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import {
  bindWorkerTurnOwner,
  getWorkerTurnExecutionIdentityCapability,
  runWorkerTurnAdmissionContinuation,
} from "./placement-turn-claim-events.js";
import { createWorkerTranscriptCommitStore } from "./transcript-commit-store.js";
import { createWorkerTranscriptCommitter } from "./transcript-commit.js";

const SESSION: WorkerSessionPlacementIdentity = {
  sessionId: "session-placement-claim-close",
  agentId: "main",
  sessionKey: "agent:main:placement-claim-close",
};

let root: string;
let database: OpenClawStateDatabase;
let store: WorkerSessionPlacementStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-placement-claim-"));
  database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  store = createWorkerSessionPlacementStore({ database });
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await fs.rm(root, { recursive: true, force: true });
});

function advanceToActive(executionMode: "worker-turn" | "remote-exec" = "worker-turn") {
  let placement = store.startDispatch({ ...SESSION, executionMode });
  placement = store.transition({
    sessionId: SESSION.sessionId,
    from: "requested",
    to: "provisioning",
    expectedGeneration: placement.generation,
    patch: { environmentId: "environment-placement-claim-close" },
  });
  placement = store.transition({
    sessionId: SESSION.sessionId,
    from: "provisioning",
    to: "syncing",
    expectedGeneration: placement.generation,
    patch: { workerBundleHash: "a".repeat(64) },
  });
  placement = store.transition({
    sessionId: SESSION.sessionId,
    from: "syncing",
    to: "starting",
    expectedGeneration: placement.generation,
    patch: {
      workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
      remoteWorkspaceDir: "/workspace/placement-claim-close",
    },
  });
  const active = store.transition({
    sessionId: SESSION.sessionId,
    from: "starting",
    to: "active",
    expectedGeneration: placement.generation,
    patch: { activeOwnerEpoch: 7 },
  });
  if (active.state !== "active") {
    throw new Error("expected active worker placement");
  }
  return active;
}

it("emits exact worker claim closure after release and owner fencing", () => {
  const closed = vi.fn();
  const unregister = store.registerTurnClaimClosedHandler(closed);
  const active = advanceToActive();
  const owner = {
    kind: "worker" as const,
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
  };
  const first = store.claimTurn({
    ...SESSION,
    owner,
    claimId: "claim-release",
    runId: "run-release",
  });
  store.releaseTurn(first);
  expect(closed).toHaveBeenLastCalledWith(first);

  const second = store.claimTurn({
    ...SESSION,
    owner,
    claimId: "claim-fence",
    runId: "run-fence",
  });
  const draining = store.startDrain({
    sessionId: active.sessionId,
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
    expectedGeneration: active.generation,
  });
  store.startReconcile({
    sessionId: active.sessionId,
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
    expectedGeneration: draining.generation,
  });
  expect(closed).toHaveBeenLastCalledWith(second);
  expect(closed).toHaveBeenCalledTimes(2);
  unregister();
});

it.each([
  { ownerKind: "worker", executionMode: "worker-turn" },
  { ownerKind: "local", executionMode: "remote-exec" },
] as const)("fences the exact $ownerKind claim when reconciliation starts", (scenario) => {
  const closed = vi.fn();
  const unregister = store.registerTurnClaimClosedHandler(closed);
  const active = advanceToActive(scenario.executionMode);
  const claim = store.claimTurn({
    ...SESSION,
    owner: placementTurnOwner(active),
    claimId: `claim-reconcile-${scenario.ownerKind}`,
    runId: `run-reconcile-${scenario.ownerKind}`,
  });
  const draining = store.startDrain({
    sessionId: active.sessionId,
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
    expectedGeneration: active.generation,
  });
  const reconcileInput = {
    sessionId: active.sessionId,
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
    expectedGeneration: draining.generation,
  };

  expect(() =>
    store.startReconcile({ ...reconcileInput, ownerEpoch: active.activeOwnerEpoch + 1 }),
  ).toThrow("Cannot reconcile stale worker placement");
  expect(store.get(active.sessionId)).toMatchObject({
    state: "draining",
    turnClaim: { claimId: claim.claimId, owner: scenario.ownerKind },
  });
  expect(closed).not.toHaveBeenCalled();

  const authorizedReconcileInput =
    scenario.ownerKind === "local"
      ? { ...reconcileInput, forceLocalClaim: true as const }
      : reconcileInput;
  if (scenario.ownerKind === "local") {
    const preserved = store.get(active.sessionId);
    expect(() => store.startReconcile(reconcileInput)).toThrow("local turn is active");
    expect(store.get(active.sessionId)).toEqual(preserved);
    expect(store.validateTurnClaim(claim)).toBe(true);
    expect(closed).not.toHaveBeenCalled();
  }

  expect(store.startReconcile(authorizedReconcileInput)).toMatchObject({
    state: "reconciling",
    turnClaim: null,
  });
  expect(store.validateTurnClaim(claim)).toBe(false);
  expect(closed).toHaveBeenCalledExactlyOnceWith(claim);
  expect(() => store.startReconcile(authorizedReconcileInput)).toThrow(
    "Cannot reconcile stale worker placement",
  );
  expect(() => store.releaseTurn(claim)).toThrow("turn claim changed before release");
  expect(closed).toHaveBeenCalledOnce();
  unregister();
});

it("rejects retained worker lineage capabilities after either owner closes", async () => {
  const active = advanceToActive();
  const owner = {
    kind: "worker" as const,
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
  };
  const placementClosedClaim = store.claimTurn({
    ...SESSION,
    owner,
    claimId: "claim-placement-close",
    runId: "run-placement-close",
  });
  const placementClosedRun = createOperationalRunInstanceRef(placementClosedClaim.runId);
  const placementClosedAuthority = claimAgentRunDelegatedAuthority(placementClosedRun);
  bindWorkerTurnOwner(
    store,
    placementClosedClaim,
    createExecutionIdentityAdmissionToken(placementClosedClaim.runId),
    placementClosedRun,
    { agentId: SESSION.agentId, sessionKey: SESSION.sessionKey },
    () => {},
  );
  const placementCapability = getWorkerTurnExecutionIdentityCapability(store, placementClosedClaim);
  if (!placementCapability) {
    throw new Error("expected placement-bound lineage capability");
  }
  let placementReceiptAuthority: (() => void) | undefined;
  await placementCapability.run((identity) => {
    placementReceiptAuthority = identity.receiptAuthority;
    identity.receiptAuthority();
  });
  store.releaseTurn(placementClosedClaim);
  expect(() => placementReceiptAuthority?.()).toThrow("worker turn authority changed");
  await expect(placementCapability.run(async () => "stale")).rejects.toThrow(
    "worker turn authority changed",
  );
  releaseAgentRunDelegatedAuthority(placementClosedAuthority);

  const runClosedClaim = store.claimTurn({
    ...SESSION,
    owner,
    claimId: "claim-run-close",
    runId: "run-run-close",
  });
  const runClosedOperational = createOperationalRunInstanceRef(runClosedClaim.runId);
  const runClosedAuthority = claimAgentRunDelegatedAuthority(runClosedOperational);
  bindWorkerTurnOwner(
    store,
    runClosedClaim,
    createExecutionIdentityAdmissionToken(runClosedClaim.runId),
    runClosedOperational,
    { agentId: SESSION.agentId, sessionKey: SESSION.sessionKey },
    () => {},
  );
  const runCapability = getWorkerTurnExecutionIdentityCapability(store, runClosedClaim);
  if (!runCapability) {
    throw new Error("expected run-bound lineage capability");
  }
  await expect(
    runCapability.run(async () => {
      await Promise.resolve();
      releaseAgentRunDelegatedAuthority(runClosedAuthority);
      return "closed-after-await";
    }),
  ).rejects.toThrow("worker turn authority changed");
  store.releaseTurn(runClosedClaim);
});

it("lets an unaudited admitted worker complete the exact turn that closes its owners", async () => {
  const active = advanceToActive();
  const claim = store.claimTurn({
    ...SESSION,
    claimId: "claim-terminal-continuation",
    runId: "run-terminal-continuation",
    owner: {
      kind: "worker",
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
    },
  });
  const operationalRunInstance = createOperationalRunInstanceRef(claim.runId);
  const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const rootAdmission = tryBeginGatewayRootWorkAdmission();
  if (!rootAdmission) {
    throw new Error("expected parent worker turn root admission");
  }
  try {
    await rootAdmission.run(async () =>
      bindWorkerTurnOwner(store, claim, undefined, operationalRunInstance, SESSION, () => {}),
    );
    await getWorkerTurnExecutionIdentityCapability(store, claim)?.run((owner) => {
      expect(owner.executionIdentityToken).toBeUndefined();
    });
    const identity: WorkerConnectionIdentity = {
      environmentId: active.environmentId,
      credentialHash: "worker-terminal-continuation",
      bundleHash: "a".repeat(64),
      sessionId: claim.sessionId,
      runId: claim.runId,
      turnClaim: claim,
      ownerEpoch: active.activeOwnerEpoch,
      rpcSetVersion: 1,
      protocolFeatures: [],
      credentialExpiresAtMs: Date.now() + 60_000,
    };

    await expect(
      runWorkerTurnAdmissionContinuation(identity, async () => {
        store.releaseTurn(claim);
        releaseAgentRunDelegatedAuthority(delegatedAuthority);
        return "completed";
      }),
    ).resolves.toBe("completed");
    expect(runWorkerTurnAdmissionContinuation(identity, async () => "stale")).toBeNull();
  } finally {
    releaseAgentRunDelegatedAuthority(delegatedAuthority);
    rootAdmission.release();
  }
});

it.each([
  "root admission",
  "no root admission",
  "released claim",
  "released run",
  "replaced claim",
  "wrong environment",
  "wrong generation",
] as const)(
  "prepares worker transcript publication only for its live owner: %s",
  async (scenario) => {
    const active = advanceToActive();
    const claim = store.claimTurn({
      ...SESSION,
      owner: placementTurnOwner(active),
      claimId: "claim-media-publication",
      runId: "run-media-publication",
    });
    const instance = createOperationalRunInstanceRef(claim.runId);
    const authority = claimAgentRunDelegatedAuthority(instance);
    const identity: WorkerConnectionIdentity = {
      environmentId: active.environmentId,
      credentialHash: "worker-media-publication",
      bundleHash: "a".repeat(64),
      sessionId: claim.sessionId,
      runId: claim.runId,
      turnClaim: claim,
      ownerEpoch: active.activeOwnerEpoch,
      rpcSetVersion: 1,
      protocolFeatures: [],
      credentialExpiresAtMs: Date.now() + 60_000,
    };
    const text = "Prepared\nMEDIA:./owned.png\nMEDIA:./unowned.png";
    const prepare = vi.fn(
      (message: ReturnType<typeof makeAgentAssistantMessage>, sourceText: string | undefined) => {
        expect(sourceText).toBe(text);
        return applyAssistantDeliveryDirectives(message, { managedMediaUrls: ["./owned.png"] });
      },
    );
    const admission =
      scenario === "root admission" ? tryBeginGatewayRootWorkAdmission() : undefined;
    const target = { ...SESSION, storePath: path.join(root, "sessions.json") };
    const published: unknown[] = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      if (update.sessionId === SESSION.sessionId) {
        published.push(
          projectSessionMessagePayload({
            ...update,
            message: update.message,
            sessionKey: SESSION.sessionKey,
          }).payload,
        );
      }
    });
    let replacement: typeof claim | undefined;
    try {
      const bind = () =>
        bindWorkerTurnOwner(store, claim, undefined, instance, SESSION, () => {}, prepare);
      if (scenario === "root admission") {
        if (!admission) {
          throw new Error("expected root admission");
        }
        await admission.run(async () => bind());
      } else {
        bind();
      }
      if (scenario === "released claim" || scenario === "replaced claim") {
        store.releaseTurn(claim);
        if (scenario === "replaced claim") {
          replacement = store.claimTurn({
            ...SESSION,
            owner: placementTurnOwner(active),
            claimId: "claim-replacement",
            runId: claim.runId,
          });
        }
      } else if (scenario === "released run") {
        releaseAgentRunDelegatedAuthority(authority);
      } else if (scenario === "wrong environment") {
        identity.environmentId = "different-environment";
      } else if (scenario === "wrong generation") {
        identity.turnClaim = { ...claim, placementGeneration: claim.placementGeneration + 1 };
      }
      await upsertSessionEntryCore(target, { sessionId: SESSION.sessionId, updatedAt: 1 });
      const committer = createWorkerTranscriptCommitter({
        getConfig: () => ({ session: { store: target.storePath } }),
        store: createWorkerTranscriptCommitStore({ database }),
      });
      const userText = "Keep this example\nMEDIA:./user.png";
      const result = await committer.commit({
        // This suite isolates projection from the RPC-owned persistence authority.
        assertCurrent: () => {},
        identity,
        request: {
          runEpoch: identity.ownerEpoch,
          seq: 1,
          baseLeafId: null,
          messages: [
            { role: "user", content: [{ type: "text", text: userText }], timestamp: 1 },
            makeAgentAssistantMessage({ content: [{ type: "text", text }], timestamp: 2 }),
          ],
        },
      });
      expect(result.ok).toBe(true);
      expect(published).toHaveLength(2);
      expect(published[0]).toMatchObject({
        message: { content: [{ type: "text", text: userText }] },
      });
      const current = scenario === "root admission" || scenario === "no root admission";
      expect(published[1]).toMatchObject({
        message: {
          content: [{ type: "text", text: current ? "Prepared\nMEDIA:./unowned.png" : text }],
        },
      });
      expect(prepare).toHaveBeenCalledTimes(current ? 1 : 0);
      const rows = await loadTranscriptEvents(target);
      expect(rows.at(-1)).toMatchObject({
        message: {
          content: [{ type: "text", text }],
          ...(current ? { openclawDelivery: { mediaUrls: ["./owned.png"] } } : {}),
        },
      });
    } finally {
      unsubscribe();
      if (store.validateTurnClaim(replacement ?? claim)) {
        store.releaseTurn(replacement ?? claim);
      }
      releaseAgentRunDelegatedAuthority(authority);
      admission?.release();
    }
  },
);
