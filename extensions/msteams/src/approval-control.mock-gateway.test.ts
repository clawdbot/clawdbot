import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { type MSTeamsActivityHandler, registerMSTeamsHandlers } from "./monitor-handler.js";
import {
  createMSTeamsMessageHandlerDeps,
  getMSTeamsTestRuntimeState,
  installMSTeamsTestRuntime,
} from "./monitor-handler.test-helpers.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const APPROVER_ID = "5e4b4b6f-c242-45de-b0de-bf44eb233145";
const APPROVAL_ID = "plugin:approval-123";

describe("msteams approval control mock-gateway proof", () => {
  it("releases the gateway waiter before the approval reaches agent dispatch", async () => {
    installMSTeamsTestRuntime();
    const runtimeState = getMSTeamsTestRuntimeState();
    runtimeState.dispatchReplyWithBufferedBlockDispatcher.mockClear();

    let releaseWaitingTurn: ((decision: string) => void) | undefined;
    const waitingTurn = new Promise<string>((resolve) => {
      releaseWaitingTurn = resolve;
    });
    const pendingApprovals = new Map([[APPROVAL_ID, releaseWaitingTurn]]);
    const gatewayRequest = vi.fn<
      NonNullable<MSTeamsMessageHandlerDeps["approvalGatewayRuntime"]>["request"]
    >(async (method, params) => {
      expect(method).toBe("approval.resolve");
      const pending = pendingApprovals.get(params.id);
      if (!pending) {
        throw new Error("unknown or expired approval id");
      }
      pendingApprovals.delete(params.id);
      pending(params.decision);
      return {
        applied: true,
        approval: {
          id: params.id,
          presentation: { kind: params.kind },
          status: "allowed",
          decision: params.decision,
        },
      } as ApprovalResolveResult;
    });
    const deps = createMSTeamsMessageHandlerDeps({
      cfg: {
        channels: { msteams: { allowFrom: [APPROVER_ID] } },
      } as OpenClawConfig,
    });
    deps.approvalGatewayRuntime = { request: gatewayRequest };

    let messageHandler: Parameters<MSTeamsActivityHandler["onMessage"]>[0] | undefined;
    const handler: MSTeamsActivityHandler = {
      onMessage: (callback) => {
        messageHandler = callback;
        return handler;
      },
      onMembersAdded: () => handler,
      onReactionsAdded: () => handler,
      onReactionsRemoved: () => handler,
    };
    registerMSTeamsHandlers(handler, deps);

    const context = {
      activity: {
        id: "message-approval-1",
        type: "message",
        text: `/approve ${APPROVAL_ID} allow-once`,
        from: { id: "bf-user", aadObjectId: APPROVER_ID, name: "Approver" },
        recipient: { id: "bot-id", name: "OpenClaw" },
        conversation: { id: "19:personal-chat", conversationType: "personal" },
        channelData: {},
        attachments: [],
      },
      sendActivity: vi.fn(async () => ({ id: "status-activity" })),
      sendActivities: vi.fn(async () => []),
    } as unknown as MSTeamsTurnContext;

    await messageHandler?.(
      context,
      vi.fn(async () => undefined),
    );
    const resumedWithDecision = await waitingTurn;

    expect(gatewayRequest).toHaveBeenCalledWith(
      "approval.resolve",
      { id: APPROVAL_ID, kind: "plugin", decision: "allow-once" },
      { clientDisplayName: `Microsoft Teams approval (${APPROVER_ID})` },
    );
    expect(resumedWithDecision).toBe("allow-once");
    expect(pendingApprovals.size).toBe(0);
    expect(runtimeState.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(context.sendActivity).toHaveBeenCalledWith(
      `✅ Approval allow-once submitted for ${APPROVAL_ID}.`,
    );

    if (process.env.PR115301_PROOF === "1") {
      console.info(
        JSON.stringify({
          verdict: "PASS",
          scenario: "msteams-approval-releases-waiting-turn",
          channel: "msteams",
          gateway: "request-level-mock-gateway",
          method: "approval.resolve",
          approvalKind: "plugin",
          ingress: "message",
          authorized: true,
          resolved: true,
          pendingLedgerEntries: pendingApprovals.size,
          waitingTurnResumed: resumedWithDecision === "allow-once",
          approvalReachedAgentQueue: false,
          secretsRedacted: true,
        }),
      );
    }
  });
});
