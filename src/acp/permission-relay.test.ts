/** Tests Gateway exec approval to ACP permission relay helpers. */
import { describe, expect, it } from "vitest";
import {
  buildAcpPermissionRequest,
  parseGatewayExecApprovalEventData,
  parseGatewayExecApprovalRequestEventPayload,
  resolveGatewayDecisionFromPermissionOutcome,
} from "./permission-relay.js";

function buildOptionsForAllowedDecisions(allowedDecisions: unknown) {
  return buildAcpPermissionRequest({
    sessionId: "session-1",
    event: {
      approvalId: "approval-1",
      command: "echo ok",
    },
    details: { allowedDecisions },
  }).options;
}

describe("ACP permission relay helpers", () => {
  it("filters unknown decisions and falls back to allow-once plus deny", () => {
    const optionIds = (allowedDecisions: unknown) =>
      buildOptionsForAllowedDecisions(allowedDecisions).map((option) => option.optionId);

    expect(optionIds(["allow-once", "bogus", "deny"])).toEqual(["allow-once", "deny"]);
    expect(optionIds(["bogus"])).toEqual(["allow-once", "deny"]);
    expect(optionIds(undefined)).toEqual(["allow-once", "deny"]);
  });

  it("builds a request_permission payload from Gateway approval data", () => {
    const event = parseGatewayExecApprovalEventData({
      phase: "requested",
      kind: "exec",
      status: "pending",
      approvalId: "approval-1",
      title: "Command approval requested",
      toolCallId: "tool-1",
      command: "echo stale",
      host: "gateway",
    });
    if (!event) {
      throw new Error("approval event did not parse");
    }

    expect(
      buildAcpPermissionRequest({
        sessionId: "session-1",
        event,
        details: {
          allowedDecisions: ["allow-once", "allow-always", "deny"],
          commandText: "echo ok",
          host: "gateway",
        },
      }),
    ).toEqual({
      sessionId: "session-1",
      toolCall: {
        toolCallId: "tool-1",
        title: "Command approval requested",
        kind: "execute",
        status: "pending",
        rawInput: {
          name: "exec",
          approvalId: "approval-1",
          command: "echo ok",
          host: "gateway",
        },
        _meta: {
          toolName: "exec",
          approvalId: "approval-1",
        },
      },
      options: [
        {
          optionId: "allow-once",
          name: "Allow once",
          kind: "allow_once",
        },
        {
          optionId: "allow-always",
          name: "Allow always",
          kind: "allow_always",
        },
        {
          optionId: "deny",
          name: "Deny",
          kind: "reject_once",
        },
      ],
    });
  });

  it("parses Gateway exec.approval.requested payloads", () => {
    expect(
      parseGatewayExecApprovalRequestEventPayload({
        id: "approval-raw",
        request: {
          command: "echo raw",
          host: "gateway",
          sessionKey: "agent:main:main",
          toolCallId: "tool-raw",
        },
      }),
    ).toEqual({
      approvalId: "approval-raw",
      command: "echo raw",
      host: "gateway",
      toolCallId: "tool-raw",
    });

    expect(parseGatewayExecApprovalRequestEventPayload({ id: "approval-raw" })).toBeNull();
    expect(
      parseGatewayExecApprovalRequestEventPayload({
        id: "approval-raw",
        request: { command: "" },
      }),
    ).toEqual({
      approvalId: "approval-raw",
      command: undefined,
      host: undefined,
    });
  });

  it("maps selected ACP outcomes back to Gateway decisions", () => {
    const options = buildOptionsForAllowedDecisions(["allow-once", "allow-always", "deny"]);

    expect(
      resolveGatewayDecisionFromPermissionOutcome(
        { outcome: { outcome: "selected", optionId: "allow-always" } },
        options,
      ),
    ).toBe("allow-always");
    expect(
      resolveGatewayDecisionFromPermissionOutcome(
        { outcome: { outcome: "selected", optionId: "missing" } },
        options,
      ),
    ).toBeUndefined();
    expect(
      resolveGatewayDecisionFromPermissionOutcome({ outcome: { outcome: "cancelled" } }, options),
    ).toBeUndefined();
  });
});
