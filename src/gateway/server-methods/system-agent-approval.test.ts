// Covers delegated system-agent approval ownership and closure.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import type { WorkerSessionTurnClaim } from "../worker-environments/placement-record.js";
import { queueDelegatedApproval } from "./system-agent-approval.js";
import type { SystemAgentChatSession } from "./system-agent.js";
import type { GatewayRequestContext } from "./types.js";

afterEach(() => {
  resetAgentRunRegistryForTest();
});

describe("queueDelegatedApproval", () => {
  const workerTurnClaim = (claimId: string): WorkerSessionTurnClaim => ({
    sessionId: "delegate-worker",
    claimId,
    runId: "delegated-worker-run",
    placementGeneration: 1,
    owner: { kind: "worker", environmentId: "worker-1", ownerEpoch: 1 },
  });

  it("refuses to apply a delegated change after its run authority closes", async () => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "a".repeat(64),
    };
    const resolveOperatorApproval = vi.fn().mockResolvedValue(null);
    const session = {
      engine: {
        getPendingOperatorProposal: () => proposal,
        resolveOperatorApproval,
      },
      lastUsedAt: 1,
      ownerKey: "agent:main:main",
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegate-closed", session]]);
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const context = {
      systemAgentApprovalManager: manager,
      broadcast: vi.fn(),
    } as unknown as GatewayRequestContext;
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-run-closed");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);

    let approvalId: string | undefined;
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
      },
      () => {
        approvalId = queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegate-closed",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        });
      },
    );
    expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
    expect(validateAgentRunDelegatedAuthority(authority)).toBe(false);

    expect(approvalId).toBeTruthy();
    expect(manager.resolve(approvalId!, "allow-once", "operator-ui")).toBe(false);
    expect(manager.getSnapshot(approvalId!)?.status).toBe("cancelled");
    expect(resolveOperatorApproval).not.toHaveBeenCalled();
  });

  it("rechecks authority after queued approval work before the final effect", async () => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "b".repeat(64),
    };
    const applyStarted = createDeferred();
    const releaseApply = createDeferred();
    const applyEffect = vi.fn();
    const resolveOperatorApproval = vi.fn(
      async (
        _decision: "allow-once" | "allow-always" | "deny" | null,
        _proposalHash: string,
        beforePersistentApply?: () => void,
      ) => {
        applyStarted.resolve();
        await releaseApply.promise;
        beforePersistentApply?.();
        applyEffect();
        return null;
      },
    );
    const session = {
      engine: {
        getPendingOperatorProposal: () => proposal,
        resolveOperatorApproval,
      },
      lastUsedAt: 1,
      ownerKey: "agent:main:main",
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegate-race", session]]);
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const publishResolved = vi.fn();
    const context = {
      systemAgentApprovalManager: manager,
      broadcast: vi.fn(),
      approvalEvents: { publishRequested: vi.fn(), publishResolved },
    } as unknown as GatewayRequestContext;
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-run-race");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);

    let approvalId: string | undefined;
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
      },
      () => {
        approvalId = queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegate-race",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        });
      },
    );

    expect(manager.resolve(approvalId!, "allow-once", "operator-ui")).toBe(true);
    await applyStarted.promise;
    expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
    releaseApply.resolve();
    const result = resolveOperatorApproval.mock.results[0]?.value;
    await expect(result).rejects.toThrow("system-agent approval authority is no longer active");
    expect(applyEffect).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(publishResolved).toHaveBeenCalledWith(
        "system-agent",
        expect.objectContaining({ applicationStatus: "not-applied" }),
      ),
    );
  });

  it("publishes the channel completion after the delegated change is applied", async () => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "c".repeat(64),
    };
    const resolveOperatorApproval = vi.fn().mockResolvedValue({
      text: "Applied",
      action: "none" as const,
      applied: true,
    });
    const session = {
      engine: {
        getPendingOperatorProposal: () => proposal,
        resolveOperatorApproval,
      },
      lastUsedAt: 1,
      ownerKey: "agent:main:main",
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegate-applied", session]]);
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const publishResolved = vi.fn();
    const context = {
      systemAgentApprovalManager: manager,
      broadcast: vi.fn(),
      approvalEvents: { publishRequested: vi.fn(), publishResolved },
    } as unknown as GatewayRequestContext;
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-run-applied");
    claimAgentRunDelegatedAuthority(operationalRunInstance);

    let approvalId: string | undefined;
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
      },
      () => {
        approvalId = queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegate-applied",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        });
      },
    );

    expect(manager.resolve(approvalId!, "allow-once", "operator-ui")).toBe(true);
    await vi.waitFor(() =>
      expect(publishResolved).toHaveBeenCalledWith(
        "system-agent",
        expect.objectContaining({ applicationStatus: "applied" }),
      ),
    );
  });

  it("fences a delegated worker turn before the persistent effect", async () => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "d".repeat(64),
    };
    const applyStarted = createDeferred();
    const releaseApply = createDeferred();
    let workerTurnActive = true;
    const applyEffect = vi.fn();
    const resolveOperatorApproval = vi.fn(
      async (
        _decision: "allow-once" | "allow-always" | "deny" | null,
        _proposalHash: string,
        beforePersistentApply?: () => void,
      ) => {
        applyStarted.resolve();
        await releaseApply.promise;
        beforePersistentApply?.();
        applyEffect();
        return null;
      },
    );
    const session = {
      engine: {
        getPendingOperatorProposal: () => proposal,
        resolveOperatorApproval,
      },
      lastUsedAt: 1,
      ownerKey: "agent:main:main",
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegate-worker", session]]);
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: (authority) =>
        validateAgentRunDelegatedAuthority(authority) && workerTurnActive,
    });
    const context = {
      systemAgentApprovalManager: manager,
      broadcast: vi.fn(),
      approvalEvents: { publishRequested: vi.fn(), publishResolved: vi.fn() },
      validateAgentRuntimeApprovalAuthority: () => workerTurnActive,
    } as unknown as GatewayRequestContext;
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-worker-run");
    claimAgentRunDelegatedAuthority(operationalRunInstance);
    const turnClaim = workerTurnClaim("turn-1");

    let approvalId: string | undefined;
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
        workerTurnClaim: turnClaim,
      },
      () => {
        approvalId = queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegate-worker",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        });
      },
    );

    expect(manager.resolve(approvalId!, "allow-once", "operator-ui")).toBe(true);
    await applyStarted.promise;
    workerTurnActive = false;
    releaseApply.resolve();
    const result = resolveOperatorApproval.mock.results[0]?.value;
    await expect(result).rejects.toThrow("system-agent approval authority is no longer active");
    expect(applyEffect).not.toHaveBeenCalled();
  });

  it("reuses an approval for a structurally equivalent worker claim", async () => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "e".repeat(64),
    };
    const session = {
      engine: {
        getPendingOperatorProposal: () => proposal,
        resolveOperatorApproval: vi.fn().mockResolvedValue(null),
      },
      lastUsedAt: 1,
      ownerKey: "agent:main:main",
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegate-worker", session]]);
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const context = {
      systemAgentApprovalManager: manager,
      broadcast: vi.fn(),
      validateAgentRuntimeApprovalAuthority: () => true,
    } as unknown as GatewayRequestContext;
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-worker-run");
    claimAgentRunDelegatedAuthority(operationalRunInstance);

    const firstClaim = workerTurnClaim("turn-2");
    let firstApprovalId: string | undefined;
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
        workerTurnClaim: firstClaim,
      },
      () => {
        firstApprovalId = queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegate-worker",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        });
      },
    );
    const secondClaim = workerTurnClaim("turn-2");
    let secondApprovalId: string | undefined;
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
        workerTurnClaim: secondClaim,
      },
      () => {
        secondApprovalId = queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegate-worker",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        });
      },
    );

    expect(secondApprovalId).toBe(firstApprovalId);
    expect(manager.listPendingRecords()).toHaveLength(1);
  });
});
