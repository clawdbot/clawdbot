import { describe, expect, it } from "vitest";
import { slackApprovalNativeRuntime } from "./approval-handler.runtime.js";

type SlackPayload = {
  text: string;
  blocks?: unknown;
};

function findSlackActionsBlock(blocks: Array<{ type?: string; elements?: unknown[] }>) {
  return blocks.find((block) => block.type === "actions");
}

describe("slackApprovalNativeRuntime", () => {
  it("renders only the allowed pending actions", async () => {
    const payload = (await slackApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: {
        app: {} as never,
        config: {} as never,
      },
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec",
      nowMs: 0,
      view: {
        approvalKind: "exec",
        approvalId: "req-1",
        commandText: "echo hi",
        metadata: [],
        actions: [
          {
            decision: "allow-once",
            label: "Allow Once",
            command: "/approve req-1 allow-once",
            style: "success",
          },
          {
            decision: "deny",
            label: "Deny",
            command: "/approve req-1 deny",
            style: "danger",
          },
        ],
      } as never,
    })) as SlackPayload;

    expect(payload.text).toContain("*Exec approval required*");
    const actionsBlock = findSlackActionsBlock(
      payload.blocks as Array<{ type?: string; elements?: unknown[] }>,
    );
    const labels = (actionsBlock?.elements ?? []).map((element) =>
      typeof element === "object" &&
      element &&
      typeof (element as { text?: { text?: unknown } }).text?.text === "string"
        ? (element as { text: { text: string } }).text.text
        : "",
    );

    expect(labels).toEqual(["Allow Once", "Deny"]);
    expect(JSON.stringify(payload.blocks)).not.toContain("Allow Always");
  });

  it("renders resolved updates without interactive blocks", async () => {
    const result = await slackApprovalNativeRuntime.presentation.buildResolvedResult({
      cfg: {} as never,
      accountId: "default",
      context: {
        app: {} as never,
        config: {} as never,
      },
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      resolved: {
        id: "req-1",
        decision: "allow-once",
        resolvedBy: "U123APPROVER",
        ts: 0,
      } as never,
      view: {
        approvalKind: "exec",
        approvalId: "req-1",
        decision: "allow-once",
        commandText: "echo hi",
        resolvedBy: "U123APPROVER",
      } as never,
      entry: {
        channelId: "D123APPROVER",
        messageTs: "1712345678.999999",
      },
    });

    expect(result.kind).toBe("update");
    if (result.kind !== "update") {
      throw new Error("expected Slack resolved update payload");
    }
    const payload = result.payload as SlackPayload;
    expect(payload.text).toContain("*Exec approval: Allowed once*");
    expect(payload.text).toContain("Resolved by <@U123APPROVER>.");
    expect(
      (payload.blocks as Array<{ type?: string }>).some((block) => block.type === "actions"),
    ).toBe(false);
  });
});
