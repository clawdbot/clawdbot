import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareSystemAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
import type { prepareSimpleCompletionModel } from "../../agents/simple-completion-runtime.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { tryBeginGatewayRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { projectSessionMessagePayload } from "../session-transcript-message.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { createWorkerInferenceExecutor } from "./inference-runtime.js";
import { placementTurnOwner, type WorkerSessionPlacementIdentity } from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import {
  bindWorkerTurnAdmission,
  bindWorkerTurnExecutionIdentity,
  getWorkerTurnExecutionIdentityCapability,
  runWorkerTurnAdmissionContinuation,
} from "./placement-turn-claim-events.js";
import { createWorkerTranscriptCommitStore } from "./transcript-commit-store.js";
import { createWorkerTranscriptCommitter } from "./transcript-commit.js";
import { prepareWorkerAgentRuntimeIdentity } from "./worker-turn-payload.js";

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
  bindWorkerTurnExecutionIdentity(
    store,
    placementClosedClaim,
    createExecutionIdentityAdmissionToken(placementClosedClaim.runId),
    placementClosedRun,
    { agentId: SESSION.agentId, sessionKey: SESSION.sessionKey },
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
  bindWorkerTurnExecutionIdentity(
    store,
    runClosedClaim,
    createExecutionIdentityAdmissionToken(runClosedClaim.runId),
    runClosedOperational,
    { agentId: SESSION.agentId, sessionKey: SESSION.sessionKey },
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
      bindWorkerTurnAdmission(store, claim, operationalRunInstance),
    );
    expect(getWorkerTurnExecutionIdentityCapability(store, claim)).toBeUndefined();
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
  { name: "remapped model", requested: "current", selected: "other", constrained: true },
  { name: "alias for the same model", requested: "short", selected: "current", constrained: true },
  { name: "unconstrained alias", requested: "short", selected: "other", constrained: false },
  {
    name: "released claim",
    requested: "current",
    selected: "current",
    constrained: true,
    close: "claim",
  },
  {
    name: "replaced claim",
    requested: "current",
    selected: "current",
    constrained: true,
    close: "replace",
  },
  {
    name: "closed run",
    requested: "current",
    selected: "current",
    constrained: true,
    close: "run",
  },
])("checks the initial worker model against its exact owner: $name", async (scenario) => {
  const provider = "fixture-worker";
  const active = advanceToActive();
  const claim = store.claimTurn({
    ...SESSION,
    owner: placementTurnOwner(active),
    claimId: "claim-initial-model",
    runId: "run-initial-model",
  });
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: root,
        model: { primary: `${provider}/${scenario.selected}` },
        models: { [`${provider}/${scenario.selected}`]: { alias: "short" } },
      },
    },
  };
  const admission = prepareSystemAgentRunAdmission(
    cfg,
    claim.runId,
    SESSION.agentId,
    "test.worker-model",
  );
  const turn = {
    preparedRunAdmission: admission,
    sessionId: SESSION.sessionId,
    sessionKey: SESSION.sessionKey,
    sessionFile: SESSION.sessionKey,
    workspaceDir: root,
    prompt: "keep the initial model",
    timeoutMs: 1_000,
    runId: claim.runId,
    config: cfg,
    provider,
    model: "current",
    ...(scenario.constrained
      ? { expectedInitialModel: Object.freeze({ provider, model: "current" }) }
      : {}),
  };
  let replacement: ReturnType<typeof store.claimTurn> | undefined;
  let replacementAdmission: ReturnType<typeof prepareSystemAgentRunAdmission> | undefined;
  try {
    // No root-work or audit scope: model consistency belongs to the live turn owner.
    await prepareWorkerAgentRuntimeIdentity({
      agentId: SESSION.agentId,
      sessionKey: SESSION.sessionKey,
      runtimeInstanceId: active.environmentId,
      placements: store,
      turn,
      turnClaim: claim,
    });
    expect(getWorkerTurnExecutionIdentityCapability(store, claim)).toBeUndefined();
    const metadataSnapshot = createPluginMetadataSnapshot({
      config: cfg,
      workspaceDir: root,
      manifestRegistry: {
        diagnostics: [],
        plugins: [
          {
            id: "worker-model-policy",
            origin: "workspace",
            rootDir: root,
            source: path.join(root, "index.js"),
            manifestPath: path.join(root, "openclaw.plugin.json"),
            providers: [provider],
            channels: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            modelIdNormalization: {
              providers: { [provider]: { aliases: { current: scenario.selected } } },
            },
          },
        ],
      },
    });
    const runtimeSnapshot: PreparedModelRuntimeSnapshot = {
      catalogOwner: undefined,
      config: cfg,
      agentId: SESSION.agentId,
      agentDir: path.join(root, "agent"),
      workspaceDir: root,
      activeProjectKeys: [],
      authModes: {},
      metadataSnapshot,
      pluginRegistry: createEmptyPluginRegistry(),
      allowGatewaySubagentBinding: true,
      modelCatalog: {
        entries: [{ provider, id: scenario.selected, name: "Fixture worker model" }],
        routeVariants: [],
      },
      configuredRuntimeModels: [],
      inlineProviderModels: [],
      createStores: () => {
        throw new Error("Fixture stops before credential stores");
      },
    };
    const release = vi.fn();
    const resolveSessionAuthSelection = vi.fn(async () => undefined);
    // Stop after model admission; full streaming is covered in inference-runtime.test.ts.
    const prepareModel = vi.fn<typeof prepareSimpleCompletionModel>(async () => ({
      error: "fixture model preparation reached",
    }));
    const executor = createWorkerInferenceExecutor({
      resolveSessionTarget: () => ({
        agentId: SESSION.agentId,
        sessionKey: SESSION.sessionKey,
        sessionEntry: { sessionId: SESSION.sessionId, updatedAt: 1 },
        sessionStore: {},
        storePath: path.join(root, "agent.sqlite"),
      }),
      acquireRuntimeLease: async () => {
        await Promise.resolve();
        if (scenario.close === "claim" || scenario.close === "replace") {
          store.releaseTurn(claim);
          if (scenario.close === "replace") {
            replacement = store.claimTurn({
              ...SESSION,
              owner: placementTurnOwner(active),
              claimId: "claim-replacement-model",
              runId: "run-replacement-model",
            });
            replacementAdmission = prepareSystemAgentRunAdmission(
              cfg,
              replacement.runId,
              SESSION.agentId,
              "test.worker-model-replacement",
            );
            await prepareWorkerAgentRuntimeIdentity({
              agentId: SESSION.agentId,
              sessionKey: SESSION.sessionKey,
              runtimeInstanceId: active.environmentId,
              placements: store,
              turn: {
                ...turn,
                preparedRunAdmission: replacementAdmission,
                runId: replacement.runId,
              },
              turnClaim: replacement,
            });
          }
        } else if (scenario.close === "run") {
          admission.close();
        }
        return { snapshot: runtimeSnapshot, release };
      },
      resolveSessionAuthSelection,
      prepareModel,
    });
    const identity: WorkerConnectionIdentity = {
      environmentId: active.environmentId,
      credentialHash: "worker-initial-model",
      bundleHash: "a".repeat(64),
      sessionId: claim.sessionId,
      runId: claim.runId,
      turnClaim: claim,
      ownerEpoch: active.activeOwnerEpoch,
      rpcSetVersion: 1,
      protocolFeatures: [],
      credentialExpiresAtMs: Date.now() + 60_000,
    };
    const outcome = await executor({
      identity,
      config: cfg,
      signal: new AbortController().signal,
      emit: vi.fn(),
      isCurrent: () => store.validateTurnClaim(claim),
      request: {
        runEpoch: active.activeOwnerEpoch,
        sessionId: claim.sessionId,
        runId: claim.runId,
        turnId: "turn-initial-model",
        modelRef: { provider, model: scenario.requested },
        context: { messages: [{ role: "user", content: "test", timestamp: 1 }] },
        options: {},
      },
    });

    if (scenario.close || (scenario.constrained && scenario.selected !== "current")) {
      expect(outcome).toMatchObject({ type: "error" });
      expect(resolveSessionAuthSelection).not.toHaveBeenCalled();
      expect(prepareModel).not.toHaveBeenCalled();
    } else {
      expect(outcome).toMatchObject({ type: "error", reason: "provider-error" });
      expect(prepareModel).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ provider, modelId: scenario.selected }),
      );
    }
    expect(release).toHaveBeenCalledOnce();
  } finally {
    admission.close();
    replacementAdmission?.close();
    if (store.validateTurnClaim(claim)) {
      store.releaseTurn(claim);
    }
    if (replacement && store.validateTurnClaim(replacement)) {
      store.releaseTurn(replacement);
    }
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
        bindWorkerTurnAdmission(store, claim, instance, {
          prepareAssistantTranscriptMessage: prepare,
        });
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
