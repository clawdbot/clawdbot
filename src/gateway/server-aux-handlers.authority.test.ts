// Exercises the Gateway-owned authority observer, without loading lazy RPC handlers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimAgentRunApprovalAuthority,
  claimAgentRunDelegatedAuthority,
  releaseAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "./agent-runtime-identity-token.js";
import { ApprovalObserverClosedError } from "./exec-approval-lifecycle.js";
import { getOperatorApprovalDetailed } from "./operator-approval-store.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

type GatewayAux = ReturnType<typeof createGatewayAuxHandlers>;
type GatewayAuxParams = Parameters<typeof createGatewayAuxHandlers>[0];
const auxiliaries: GatewayAux[] = [];
let fixture: OpenClawTestState | undefined;

function createAuthorityHarness(
  params: Pick<
    GatewayAuxParams,
    | "onApprovalLifecycle"
    | "onAgentRunAuthorityClosed"
    | "validateAgentRuntimeDelegatedAuthority"
    | "registerWorkerTurnClaimClosedHandler"
  > = {},
): GatewayAux {
  const aux = createGatewayAuxHandlers({
    log: {},
    activateRuntimeSecrets: async () => {
      throw new Error("unexpected secrets reload");
    },
    sharedGatewaySessionGenerationState: { current: undefined, required: null },
    resolveSharedGatewaySessionGenerationForConfig: () => undefined,
    clients: [],
    channelManager: {
      startChannel: async () => new Map(),
      stopChannel: async () => {},
      isManuallyStopped: () => false,
      resolveRuntimeAccountId: (_channel, accountId) => accountId,
    },
    logChannels: { info: () => {} },
    ...params,
  });
  auxiliaries.push(aux);
  return aux;
}

beforeEach(async () => {
  if (fixture) {
    throw new Error("Previous auxiliary owner cleanup did not finish");
  }
  fixture = await createOpenClawTestState({ label: "gateway-aux-authority" });
});

afterEach(async () => {
  for (const aux of auxiliaries) {
    await aux.stopOperatorInteractions();
  }
  auxiliaries.length = 0;
  resetAgentRunRegistryForTest();
  await fixture?.cleanup();
  fixture = undefined;
});

describe("gateway auxiliary authority lifecycle", () => {
  it("shares one approval epoch per gateway lifetime and rotates it on restart", () => {
    const first = createAuthorityHarness({});
    const second = createAuthorityHarness({});

    expect(first.execApprovalManager.runtimeEpoch).toBe(first.pluginApprovalManager.runtimeEpoch);
    expect(second.execApprovalManager.runtimeEpoch).toBe(second.pluginApprovalManager.runtimeEpoch);
    expect(first.execApprovalManager.runtimeEpoch).not.toBe(
      second.execApprovalManager.runtimeEpoch,
    );
  });

  it("leaves durable approval truth pending when authority closes after owner stop", async () => {
    const onAgentRunAuthorityClosed = vi.fn();
    const gatewayAux = createAuthorityHarness({
      onAgentRunAuthorityClosed,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const authority = claimAgentRunDelegatedAuthority({
      instanceId: "stopped-approval-owner",
      runId: "stopped-approval-run",
    });
    const record = gatewayAux.execApprovalManager.create({ command: "echo pending" }, 60_000);
    record.agentRuntimeDelegatedAuthority = { ...authority, kind: "local" };
    void gatewayAux.execApprovalManager.register(record, 60_000);
    const pending = getOperatorApprovalDetailed({ id: record.id });
    expect(pending).toMatchObject({
      outcome: "found",
      record: { status: "pending", decision: null, resolvedAtMs: null },
    });
    const observerClosed = expect(
      gatewayAux.execApprovalManager.awaitDecision(record.id),
    ).rejects.toBeInstanceOf(ApprovalObserverClosedError);

    gatewayAux.beginCloseApprovalObservers();
    await observerClosed;
    await gatewayAux.stopOperatorInteractions();
    releaseAgentRunDelegatedAuthority(authority);

    expect(onAgentRunAuthorityClosed).not.toHaveBeenCalled();
    expect(getOperatorApprovalDetailed({ id: record.id })).toEqual(pending);
  });

  it("cancels generation approvals without closing whole-run capabilities", async () => {
    const onAgentRunAuthorityClosed = vi.fn();
    const gatewayAux = createAuthorityHarness({
      onAgentRunAuthorityClosed,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const operationalRunInstance = Object.freeze({
      instanceId: "egress-proxy-instance",
      runId: "egress-proxy-run",
    });
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const generation = new AbortController();
    const scoped = claimAgentRunApprovalAuthority(authority, [generation.signal]);
    const record = gatewayAux.execApprovalManager.create({ command: "echo old" }, 2_000);
    record.agentRuntimeDelegatedAuthority = { ...scoped, kind: "local" };
    const pending = gatewayAux.execApprovalManager.register(record, 2_000);

    generation.abort();

    await expect(pending).resolves.toBeNull();
    expect(gatewayAux.execApprovalManager.getSnapshot(record.id)?.status).toBe("cancelled");
    expect(onAgentRunAuthorityClosed).not.toHaveBeenCalled();
    expect(validateAgentRunDelegatedAuthority(authority)).toBe(true);

    releaseAgentRunDelegatedAuthority(authority);

    expect(onAgentRunAuthorityClosed).toHaveBeenCalledOnce();
    expect(onAgentRunAuthorityClosed).toHaveBeenCalledWith(
      expect.objectContaining({ operationalRunInstance }),
    );
  });

  it.each(["release", "replacement", "generation"] as const)(
    "settles credential questions on authority %s without waiting for a read",
    async (closure) => {
      const onAgentRunAuthorityClosed = vi.fn();
      const gatewayAux = createAuthorityHarness({
        onAgentRunAuthorityClosed,
      });
      const operationalRunInstance = Object.freeze({
        instanceId: "egress-proxy-instance",
        runId: "egress-proxy-run",
      });
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      const onResolved = vi.fn();
      const question = gatewayAux.questionManager.request({
        questions: [
          {
            questionId: "key",
            header: "Key",
            question: "Credential",
            options: [],
            isSecret: true,
            secretStore: { name: "SERVICE_API_KEY", kind: "secret" },
          },
        ],
        timeoutMs: 60_000,
        isRequesterActive: () => validateAgentRunDelegatedAuthority(authority),
        onResolved,
      });
      const answer = gatewayAux.questionManager.waitAnswer(question.id);
      let replacement: typeof authority | undefined;
      try {
        if (closure === "release") {
          releaseAgentRunDelegatedAuthority(authority);
        } else if (closure === "replacement") {
          replacement = claimAgentRunDelegatedAuthority({
            ...operationalRunInstance,
            instanceId: "replacement",
          });
        } else {
          rotateAgentRunRegistryLifecycleGeneration();
        }
        // get/list also check liveness, so assert push delivery before either read.
        expect(onResolved).toHaveBeenCalledExactlyOnceWith({
          id: question.id,
          status: "cancelled",
        });
        await expect(answer).resolves.toEqual({ status: "cancelled" });
        expect(onAgentRunAuthorityClosed).toHaveBeenCalledOnce();
        expect(onAgentRunAuthorityClosed).toHaveBeenCalledWith(
          expect.objectContaining({ operationalRunInstance }),
        );
      } finally {
        await gatewayAux.stopOperatorInteractions();
        const remaining = replacement ?? authority;
        releaseAgentRunContext(remaining.operationalRunInstance.runId, remaining.claimId);
      }
    },
  );

  it("keeps reentrant question callbacks from losing another authority closure", async () => {
    const gatewayAux = createAuthorityHarness({});
    const authorities = ["first", "second", "live"].map((id) =>
      claimAgentRunDelegatedAuthority({ runId: `question-${id}`, instanceId: id }),
    );
    const events: string[] = [];
    const questions = authorities.map((authority, index) =>
      gatewayAux.questionManager.request({
        id: authority.operationalRunInstance.instanceId,
        questions: [
          {
            questionId: "key",
            header: "Key",
            question: "Credential",
            options: [],
            isSecret: true,
            secretStore: { name: "SERVICE_API_KEY", kind: "secret" },
          },
        ],
        timeoutMs: 60_000,
        isRequesterActive: () => validateAgentRunDelegatedAuthority(authority),
        onResolved: (event) => {
          events.push(event.id);
          if (index === 0) {
            releaseAgentRunDelegatedAuthority(authorities[1]!);
          }
        },
      }),
    );
    const answers = questions
      .slice(0, 2)
      .map((question) => gatewayAux.questionManager.waitAnswer(question.id));
    try {
      releaseAgentRunDelegatedAuthority(authorities[0]!);
      expect(events).toEqual(["first", "second"]);
      await expect(Promise.all(answers)).resolves.toEqual([
        { status: "cancelled" },
        { status: "cancelled" },
      ]);
      expect(gatewayAux.questionManager.list().map((question) => question.id)).toEqual(["live"]);
    } finally {
      await gatewayAux.stopOperatorInteractions();
      authorities.forEach(releaseAgentRunDelegatedAuthority);
    }
  });

  it("publishes exec.approval.resolved when the gateway timeout expires an approval", async () => {
    vi.useFakeTimers();
    try {
      const gatewayAux = createAuthorityHarness({});
      const broadcast = vi.fn();
      const publishResolved = vi.fn();
      const handleWebPushExpired = vi.spyOn(gatewayAux.approvalWebPushDelivery, "handleExpired");
      gatewayAux.bindApprovalPublicationContext({
        broadcast,
        broadcastToConnIds: vi.fn(),
        approvalEvents: { publishResolved },
        approvalWebPushDelivery: gatewayAux.approvalWebPushDelivery,
        logGateway: { error: vi.fn() },
      } as never);
      const record = gatewayAux.execApprovalManager.create(
        { command: "echo expires" },
        1_000,
        "exec-timeout-publish",
      );
      const decision = gatewayAux.execApprovalManager.register(record, 1_000);

      await vi.advanceTimersByTimeAsync(2_000);

      await expect(decision).resolves.toBeNull();
      // The gateway clock owns expiry: reviewer surfaces must receive the
      // terminal event instead of pruning on their own (skewed) clocks.
      await vi.waitFor(() => expect(publishResolved).toHaveBeenCalledTimes(1));
      expect(handleWebPushExpired).toHaveBeenCalledWith(
        expect.objectContaining({ id: "exec-timeout-publish" }),
      );
      expect(broadcast).toHaveBeenCalledWith(
        "exec.approval.resolved",
        expect.objectContaining({ id: "exec-timeout-publish", decision: "deny" }),
        expect.anything(),
      );
      await gatewayAux.stopOperatorInteractions();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles and publishes both approval kinds from the production worker-claim observer", async () => {
    const database = openOpenClawStateDatabase();
    const placements = createWorkerSessionPlacementStore({ database });
    const identity = {
      sessionId: "session-worker-close",
      agentId: "main",
      sessionKey: "agent:main:worker-close",
    };
    let placement = placements.startDispatch(identity);
    placement = placements.transition({
      sessionId: identity.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId: "worker-env" },
    });
    placement = placements.transition({
      sessionId: identity.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: placement.generation,
      patch: { workerBundleHash: "a".repeat(64) },
    });
    placement = placements.transition({
      sessionId: identity.sessionId,
      from: "syncing",
      to: "starting",
      expectedGeneration: placement.generation,
      patch: {
        workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
        remoteWorkspaceDir: "/workspace/worker-close",
      },
    });
    placement = placements.transition({
      sessionId: identity.sessionId,
      from: "starting",
      to: "active",
      expectedGeneration: placement.generation,
      patch: { activeOwnerEpoch: 7 },
    });
    if (placement.state !== "active") {
      throw new Error("expected active worker placement");
    }
    const operationalRunInstance = Object.freeze({
      instanceId: "worker-operational-instance",
      runId: "worker-run-close",
    });
    const runAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const turnClaim = placements.claimTurn({
      ...identity,
      claimId: "worker-claim-close",
      runId: operationalRunInstance.runId,
      owner: {
        kind: "worker",
        environmentId: placement.environmentId,
        ownerEpoch: placement.activeOwnerEpoch,
      },
    });
    const authority = { kind: "worker" as const, ...runAuthority, turnClaim };
    const validateAuthority = createAgentRuntimeApprovalAuthorityValidator(placements);
    const lifecycle = vi.fn();
    const gatewayAux = createAuthorityHarness({
      onApprovalLifecycle: lifecycle,
      validateAgentRuntimeDelegatedAuthority: (candidate) =>
        validateAuthority({
          kind: "agentRuntime",
          agentId: identity.agentId,
          sessionKey: identity.sessionKey,
          operationalRunInstance: candidate.operationalRunInstance,
          delegatedAuthority: candidate,
        }),
      registerWorkerTurnClaimClosedHandler: (handler) =>
        placements.registerTurnClaimClosedHandler(handler),
    });
    const broadcast = vi.fn();
    const publishResolved = vi.fn();
    gatewayAux.bindApprovalPublicationContext({
      broadcast,
      broadcastToConnIds: vi.fn(),
      approvalEvents: { publishResolved },
      logGateway: { error: vi.fn() },
    } as never);
    const execRecord = gatewayAux.execApprovalManager.create(
      { command: "echo worker", runId: turnClaim.runId },
      60_000,
      "exec-worker-close",
    );
    execRecord.agentRuntimeDelegatedAuthority = authority;
    const execDecision = gatewayAux.execApprovalManager.register(execRecord, 60_000);
    const pluginRecord = gatewayAux.pluginApprovalManager.create(
      { title: "Worker action", description: "Close with worker claim", runId: turnClaim.runId },
      60_000,
      "plugin-worker-close",
    );
    pluginRecord.agentRuntimeDelegatedAuthority = authority;
    const pluginDecision = gatewayAux.pluginApprovalManager.register(pluginRecord, 60_000);
    const questionResolved = vi.fn();
    gatewayAux.questionManager.request({
      questions: [
        {
          questionId: "key",
          header: "Key",
          question: "Credential",
          options: [],
          isSecret: true,
          secretStore: { name: "SERVICE_API_KEY", kind: "secret" },
        },
      ],
      timeoutMs: 60_000,
      isRequesterActive: () =>
        validateAuthority({
          kind: "agentRuntime",
          agentId: identity.agentId,
          sessionKey: identity.sessionKey,
          operationalRunInstance,
          delegatedAuthority: authority,
        }),
      onResolved: questionResolved,
    });

    placements.releaseTurn(turnClaim);

    expect(questionResolved).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: "cancelled" }),
    );
    await expect(execDecision).resolves.toBeNull();
    await expect(pluginDecision).resolves.toBeNull();
    await vi.waitFor(() => expect(publishResolved).toHaveBeenCalledTimes(2));
    expect(publishResolved.mock.calls.map((call) => call[0])).toEqual(["exec", "plugin"]);
    expect(broadcast.mock.calls.map((call) => call[0])).toEqual([
      "exec.approval.resolved",
      "plugin.approval.resolved",
    ]);
    expect(lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "terminal",
        record: expect.objectContaining({ kind: "exec", status: "cancelled" }),
      }),
    );
    expect(lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "terminal",
        record: expect.objectContaining({ kind: "plugin", status: "cancelled" }),
      }),
    );
    await gatewayAux.stopOperatorInteractions();
    releaseAgentRunDelegatedAuthority(runAuthority);
  });
});
