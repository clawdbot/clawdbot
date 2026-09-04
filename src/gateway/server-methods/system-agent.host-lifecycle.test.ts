// Register shared mocks before loading the engine and request handlers.
import "./system-agent.mocks.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createGatewayHostLifecycle } from "../../cli/gateway-cli/host-lifecycle.js";
import { prepareHostedGatewayStop, type HostedGatewayStop } from "../../daemon/hosted-stop.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import { getActiveGatewayRootWorkCount } from "../../process/gateway-work-admission.js";
import * as systemAgentAudit from "../../system-agent/audit.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import { readLastSystemAgentAuditEntry } from "../../system-agent/system-agent.test-helpers.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayHostLifecycle } from "../server-public.js";
import type { WorkerSessionTurnClaim } from "../worker-environments/placement-record.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import {
  callChat,
  defaultClient,
  makeContext,
  makeRespond,
  systemAgentLane,
  transcriptStoreMocks,
  useSystemAgentGatewayTestFixture,
  verifiedConfig,
  type RespondCall,
} from "./system-agent.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

vi.mock("../../daemon/hosted-stop.js", () => ({ prepareHostedGatewayStop: vi.fn() }));

const {
  systemAgentTempDirs,
  requireVerifiedInferenceFixture,
  requireVerifiedInferenceDeps,
  seededSession,
} = useSystemAgentGatewayTestFixture();

describe("openclaw.chat hosted lifecycle", () => {
  it.for([
    { action: "restart", fullPermission: false, loss: "none" },
    { action: "stop", fullPermission: false, loss: "none" },
    { action: "stop", fullPermission: true, loss: "none" },
    { action: "stop", fullPermission: false, loss: "run" },
    ...(["run", "tool", "gateway", "worker", "session"] as const).map((loss) => ({
      action: "stop" as const,
      fullPermission: true,
      loss,
    })),
  ] as const)(
    "settles delegated $action through host acceptance (Full Access=$fullPermission, loss=$loss)",
    async ({ action, fullPermission, loss }, testContext) => {
      const preparationStarted = createDeferred();
      const releasePreparation = createDeferred();
      const auditStarted = createDeferred();
      const releaseAudit = createDeferred();
      const stateDir = systemAgentTempDirs.make("openclaw-delegated-gateway-lifecycle-");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
      fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify(verifiedConfig));
      const nativeEffect = vi.fn<HostedGatewayStop["execute"]>(async (assertCurrent) => {
        assertCurrent();
        return { outcome: "accepted" };
      });
      const dispose = vi.fn<HostedGatewayStop["dispose"]>().mockResolvedValue(undefined);
      vi.mocked(prepareHostedGatewayStop).mockImplementation(async (_owner, assertCaller) => {
        assertCaller();
        preparationStarted.resolve();
        await releasePreparation.promise;
        // The real host owner must revalidate before accepting this prepared intent.
        return { execute: nativeEffect, dispose };
      });
      let serving = true;
      const acceptStop = vi.fn(() => {
        serving = false;
      });
      const host = createGatewayHostLifecycle({
        isCurrent: () => true,
        isServing: () => serving,
        processOwner: { ownsProcessLifecycle: true, supervisor: null },
        acceptStop,
      });
      const gatewayHostLifecycle: GatewayHostLifecycle =
        action === "stop"
          ? host.capability
          : {
              async request(_action, assertCaller) {
                assertCaller();
                preparationStarted.resolve();
                await releasePreparation.promise;
                assertCaller();
                return { ok: true, value: { outcome: "scheduled" } };
              },
            };
      const requestLifecycle = vi.spyOn(gatewayHostLifecycle, "request");
      const appendAudit = systemAgentAudit.appendSystemAgentAuditEntry;
      vi.spyOn(systemAgentAudit, "appendSystemAgentAuditEntry").mockImplementation(
        async (entry) => {
          auditStarted.resolve();
          await releaseAudit.promise;
          return await appendAudit(entry);
        },
      );
      const engine = new SystemAgentChatEngine({
        operatorApprovalOnly: true,
        surface: "gateway",
        verifiedInference: requireVerifiedInferenceFixture(),
        deps: {
          ...requireVerifiedInferenceDeps(),
          gatewayHostLifecycle,
        },
      });
      engine.propose({ kind: action === "stop" ? "gateway-stop" : "gateway-restart" });
      const proposalHash = expectDefined(
        engine.getPendingOperatorProposal(),
        "lifecycle proposal",
      ).hash;
      const handle = vi
        .spyOn(engine, "handle")
        .mockResolvedValue({ text: "Approval pending.", action: "none" });
      const resolveOperatorApproval = vi.spyOn(engine, "resolveOperatorApproval");
      const delegatedSession = seededSession({
        engine,
        ownerKey: JSON.stringify(["main", "agent:main:main"]),
      });
      const sessions = new Map<string, SystemAgentChatSession>([["delegate-1", delegatedSession]]);
      let workerActive = true;
      const manager = createTestApprovalManager<SystemAgentApprovalRequestPayload>(testContext, {
        approvalKind: "system-agent",
        resolveAllowedDecisions: (request) => request.allowedDecisions,
        validateAgentRuntimeDelegatedAuthority: (authority) =>
          validateAgentRunDelegatedAuthority(authority) && workerActive,
      });
      const operationalRunInstance = createOperationalRunInstanceRef(
        "delegated-gateway-lifecycle-run",
      );
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      const controller = new AbortController();
      const broadcast = vi.fn();
      const context = {
        ...makeContext(sessions),
        systemAgentApprovalManager: manager,
        broadcast,
        broadcastToConnIds: vi.fn(),
        hasExecApprovalClients: () => true,
        validateAgentRuntimeApprovalAuthority: () => workerActive,
      } as unknown as GatewayRequestContext;
      let liveContext = context;
      const workerTurnClaim: WorkerSessionTurnClaim = {
        sessionId: "delegate-1",
        claimId: "hosted-stop-turn",
        runId: operationalRunInstance.runId,
        placementGeneration: 1,
        owner: { kind: "worker", environmentId: "worker-1", ownerEpoch: 1 },
      };
      const identity = {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
        approvalAuthority: authority,
        fullPermission,
        gatewayContextResolver: () => liveContext,
        approvalSignals: [controller.signal],
        ...(loss === "worker" ? { workerTurnClaim } : {}),
      };
      const requestResponses = makeRespond();
      const rootsAtResponse: number[] = [];
      const persistedHistoryAtResponse: unknown[][] = [];
      const pendingChat = withGatewayToolCallerIdentity(identity, () =>
        handleGatewayRequest({
          req: {
            type: "req",
            id: "delegated-gateway-lifecycle",
            method: "openclaw.chat",
            params: {
              sessionId: "delegate-1",
              message: `${action} Gateway.`,
              context: { page: "channels" },
              delegation: { agentId: "main", sessionKey: "agent:main:main" },
            },
          },
          respond: (ok, payload, error) => {
            rootsAtResponse.push(getActiveGatewayRootWorkCount());
            persistedHistoryAtResponse.push(
              transcriptStoreMocks.appendTranscriptTurn.mock.calls.map(([turn]) => turn),
            );
            requestResponses.respond(ok, payload, error);
          },
          client: {
            ...defaultClient,
            connect: { ...defaultClient.connect, role: "operator", scopes: ["operator.admin"] },
          } as GatewayClient,
          isWebchatConnect: () => false,
          context,
          extraHandlers: { "openclaw.chat": systemAgentHandlers["openclaw.chat"]! },
        }),
      );
      let sameOwnerChat: Promise<RespondCall> | undefined;
      try {
        if (!fullPermission) {
          await vi.waitFor(() => expect(manager.listPendingRecords()).toHaveLength(1));
          expect(requestResponses.calls).toHaveLength(0);
          expect(getActiveGatewayRootWorkCount()).toBe(1);
          expect(systemAgentLane()).toMatchObject({ activeCount: 0, queuedCount: 0 });
          const proposalId = expectDefined(manager.listPendingRecords()[0], "pending approval").id;
          expect(manager.getSnapshot(proposalId)).toMatchObject({
            request: { proposalHash, agentId: "main", sessionKey: "agent:main:main" },
          });
          expect(manager.getSnapshot(proposalId)?.decision).toBeUndefined();
          expect(broadcast).toHaveBeenCalledWith(
            "openclaw.approval.requested",
            expect.objectContaining({ id: proposalId }),
            { dropIfSlow: true },
          );
          expect(resolveOperatorApproval).not.toHaveBeenCalled();
          expect(handle).toHaveBeenNthCalledWith(1, `${action} Gateway.`);
          if (loss === "none") {
            sameOwnerChat = withGatewayToolCallerIdentity(identity, () =>
              callChat(context, {
                sessionId: "delegate-1",
                message: "yes",
                delegation: { agentId: "main", sessionKey: "agent:main:main" },
              }),
            );
            await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(2));
          }
          expect(manager.resolve(proposalId, "allow-once", "operator-ui")).toBe(true);
        }
        await Promise.race([
          preparationStarted.promise,
          pendingChat.then(() => {
            throw new Error("Delegated lifecycle replied before host preparation");
          }),
        ]);
        expect(requestResponses.calls).toHaveLength(0);
        expect(getActiveGatewayRootWorkCount()).toBeGreaterThan(0);
        expect(systemAgentLane()).toMatchObject({ activeCount: 1, queuedCount: 0 });
        expect(delegatedSession.pendingApproval).toBeUndefined();
        expect(acceptStop).not.toHaveBeenCalled();
        expect(nativeEffect).not.toHaveBeenCalled();
        expect(validateAgentRunDelegatedAuthority(authority)).toBe(true);
        if (fullPermission) {
          expect(manager.listPendingRecords()).toEqual([]);
          expect(broadcast).not.toHaveBeenCalled();
        }
        if (loss === "run") {
          expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
        } else if (loss === "tool") {
          controller.abort();
        } else if (loss === "gateway") {
          liveContext = { ...context };
        } else if (loss === "worker") {
          workerActive = false;
        } else if (loss === "session") {
          sessions.set("delegate-1", { ...delegatedSession });
        }
        releasePreparation.resolve();
        expect(resolveOperatorApproval).toHaveBeenCalledWith(
          "allow-once",
          proposalHash,
          expect.any(Function),
          undefined,
        );
        expect(requestLifecycle).toHaveBeenCalledExactlyOnceWith(action, expect.any(Function));
        if (loss === "none") {
          await auditStarted.promise;
          expect(acceptStop).toHaveBeenCalledTimes(action === "stop" ? 1 : 0);
          expect(nativeEffect).not.toHaveBeenCalled();
          expect(requestResponses.calls).toHaveLength(0);
          expect(getActiveGatewayRootWorkCount()).toBeGreaterThan(0);
          expect(readLastSystemAgentAuditEntry()).toBeUndefined();
        }
        releaseAudit.resolve();
        await pendingChat;
        const expectedReply =
          loss === "none"
            ? `[openclaw] done: gateway.${action}`
            : "system-agent approval authority is no longer active";
        expect(requestResponses.calls).toHaveLength(1);
        expect(rootsAtResponse).toEqual([expect.any(Number)]);
        expect(rootsAtResponse[0]).toBeGreaterThan(0);
        expect(persistedHistoryAtResponse[0]).toContainEqual(
          expect.objectContaining({
            role: "assistant",
            text: expect.stringContaining(expectedReply),
          }),
        );
        expect(requestResponses.calls[0]).toMatchObject({
          ok: true,
          payload: { reply: expect.stringContaining(expectedReply) },
        });
        if (sameOwnerChat) {
          expect((await sameOwnerChat).payload).toEqual(requestResponses.calls[0]?.payload);
        }
        expect(systemAgentLane()).toMatchObject({ activeCount: 0, queuedCount: 0 });
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(transcriptStoreMocks.appendTranscriptTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            role: "assistant",
            text: expect.stringContaining(expectedReply),
          }),
        );
        expect(engine.getPendingOperatorProposal()).toBeNull();
        expect(nativeEffect).not.toHaveBeenCalled();
        if (loss !== "none") {
          expect(acceptStop).not.toHaveBeenCalled();
          expect(readLastSystemAgentAuditEntry()).toBeUndefined();
          expect(dispose).toHaveBeenCalledOnce();
          await expect(host.finishStop()).resolves.toEqual({ outcome: "retired" });
          expect(nativeEffect).not.toHaveBeenCalled();
        } else {
          expect(readLastSystemAgentAuditEntry()).toMatchObject({
            operation: `gateway.${action}`,
            summary: `Scheduled Gateway ${action}`,
          });
          if (action === "stop") {
            // The accepted intent survives its caller; run-loop tests own drain/close ordering.
            controller.abort();
            expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
            await expect(host.finishStop()).resolves.toEqual({ outcome: "accepted" });
            expect(nativeEffect).toHaveBeenCalledOnce();
          }
        }
      } finally {
        releasePreparation.resolve();
        releaseAudit.resolve();
        controller.abort();
        for (const record of manager.listPendingRecords()) {
          manager.expire(record.id);
        }
        await Promise.allSettled([pendingChat, sameOwnerChat]);
        await host.retire();
        await engine.dispose();
      }
    },
  );
});
