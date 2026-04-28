import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { handlePendingApprovalRequest } from "./approval-shared.js";
import type { GatewayRequestContext } from "./types.js";

const hasApprovalTurnSourceRouteMock = vi.hoisted(() => vi.fn(() => true));

vi.mock("../../infra/approval-turn-source.js", () => ({
  hasApprovalTurnSourceRoute: hasApprovalTurnSourceRouteMock,
}));

describe("handlePendingApprovalRequest", () => {
  afterEach(() => {
    hasApprovalTurnSourceRouteMock.mockClear();
  });

  it("does not resolve turn-source routes when approval clients are already available", async () => {
    const manager = new ExecApprovalManager();
    const record = manager.create(
      {
        command: "echo ok",
        turnSourceChannel: "feishu",
        turnSourceAccountId: "work",
      },
      60_000,
      "approval-with-client",
    );
    const decisionPromise = manager.register(record, 60_000);
    const respond = vi.fn();
    const requestPromise = handlePendingApprovalRequest({
      manager,
      record,
      decisionPromise,
      respond,
      context: {
        broadcast: vi.fn(),
        hasExecApprovalClients: () => true,
      } as unknown as GatewayRequestContext,
      requestEventName: "exec.approval.requested",
      requestEvent: {
        id: record.id,
        request: record.request,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      },
      twoPhase: true,
      deliverRequest: () => false,
    });

    await Promise.resolve();
    expect(hasApprovalTurnSourceRouteMock).not.toHaveBeenCalled();

    expect(manager.resolve(record.id, "allow-once")).toBe(true);
    await requestPromise;
  });
});
