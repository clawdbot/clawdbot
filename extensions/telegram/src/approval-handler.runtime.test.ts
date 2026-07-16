import { describe, expect, it, vi } from "vitest";
import { telegramApprovalNativeRuntime } from "./approval-handler.runtime.js";

type TelegramPayload = {
  text: string;
  buttons?: Array<Array<{ text: string }>>;
};

describe("telegramApprovalNativeRuntime", () => {
  it("renders only the allowed pending buttons", async () => {
    const payload = (await telegramApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: {
        token: "tg-token",
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
    })) as TelegramPayload;

    expect(payload.text).toContain("/approve req-1 allow-once");
    expect(payload.text).not.toContain("allow-always");
    expect(payload.buttons?.[0]?.map((button) => button.text)).toEqual(["Allow Once", "Deny"]);
  });

  it("passes topic thread ids to typing and message delivery", async () => {
    const sendTyping = vi.fn().mockResolvedValue({ ok: true });
    const sendMessage = vi.fn().mockResolvedValue({
      chatId: "-1003841603622",
      messageId: "m1",
    });

    const entry = await telegramApprovalNativeRuntime.transport.deliverPending({
      cfg: {} as never,
      accountId: "default",
      context: {
        token: "tg-token",
        deps: {
          sendTyping,
          sendMessage,
        },
      },
      plannedTarget: {
        surface: "origin",
        reason: "preferred",
        target: {
          to: "-1003841603622",
          threadId: 928,
        },
      },
      preparedTarget: {
        chatId: "-1003841603622",
        messageThreadId: 928,
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
      view: {
        approvalKind: "exec",
        approvalId: "req-1",
        commandText: "echo hi",
        actions: [],
      } as never,
      pendingPayload: {
        text: "pending",
        buttons: [],
      },
    });

    expect(sendTyping).toHaveBeenCalledWith(
      "-1003841603622",
      expect.objectContaining({
        token: "tg-token",
        accountId: "default",
        messageThreadId: 928,
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "-1003841603622",
      "pending",
      expect.objectContaining({
        token: "tg-token",
        accountId: "default",
        messageThreadId: 928,
        buttons: [],
      }),
    );
    expect(entry).toEqual({
      chatId: "-1003841603622",
      messageId: "m1",
    });
  });
});
