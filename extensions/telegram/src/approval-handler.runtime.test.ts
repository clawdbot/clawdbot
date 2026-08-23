// Telegram tests cover approval handler plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { telegramApprovalNativeRuntime } from "./approval-handler.runtime.js";
import { buildTelegramCanonicalApprovalTerminalText } from "./approval-terminal.js";

type TelegramPayload = {
  text: string;
  buttons?: Array<Array<{ text: string; callback_data?: string }>>;
};

describe("telegramApprovalNativeRuntime", () => {
  it("distinguishes a typed click winner from a losing surface", () => {
    const approval = {
      id: "req-1",
      status: "denied",
      decision: "deny",
    } as never;

    expect(
      buildTelegramCanonicalApprovalTerminalText({
        result: { applied: true, approval },
        fallbackApprovalId: "req-1",
      }),
    ).toContain("✅ Approval resolved here\nCanonical result: Denied");
    expect(
      buildTelegramCanonicalApprovalTerminalText({
        result: { applied: false, approval },
        fallbackApprovalId: "req-1",
      }),
    ).toContain("ℹ️ Approval already resolved\nCanonical result: Denied");
    expect(
      buildTelegramCanonicalApprovalTerminalText({
        result: {
          applied: false,
          approval: { id: "req\n1", status: "denied", decision: "deny" } as never,
        },
        fallbackApprovalId: "req-1",
      }),
    ).toContain("ID: req\\n1");
  });

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
            action: {
              type: "approval",
              approvalId: "req-1",
              approvalKind: "exec",
              decision: "allow-once",
            },
            command: "/approve req-1 allow-once",
            style: "success",
          },
          {
            decision: "deny",
            label: "Deny",
            action: {
              type: "approval",
              approvalId: "req-1",
              approvalKind: "exec",
              decision: "deny",
            },
            command: "/approve req-1 deny",
            style: "danger",
          },
        ],
      } as never,
    })) as TelegramPayload;

    expect(payload.text).toContain("/approve req-1 allow-once");
    expect(payload.text).not.toContain("allow-always");
    expect(payload.buttons?.[0]?.map((button) => button.text)).toEqual(["Allow Once", "Deny"]);
    expect(payload.buttons?.[0]?.map((button) => button.callback_data)).toEqual([
      "tga1:e:o:req-1",
      "tga1:e:d:req-1",
    ]);
  });

  it("renders resolved and expired events as visible terminal receipts", async () => {
    const request = {
      id: "req-1",
      request: { command: "echo hi" },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    };
    const resolved = await telegramApprovalNativeRuntime.presentation.buildResolvedResult({
      cfg: {} as never,
      accountId: "default",
      context: { token: "tg-token" },
      request,
      resolved: {
        id: "req-1",
        decision: "deny",
        resolvedBy: "telegram:9",
        ts: 1,
      },
      view: {
        approvalKind: "exec",
        approvalId: "req-1",
        phase: "resolved",
        title: "Exec approval",
        metadata: [],
        commandText: "echo hi",
        decision: "deny",
        resolvedBy: "telegram:9",
      } as never,
      entry: { chatId: "9", messageId: "m1" },
    });
    const expired = await telegramApprovalNativeRuntime.presentation.buildExpiredResult({
      cfg: {} as never,
      accountId: "default",
      context: { token: "tg-token" },
      request,
      view: {
        approvalKind: "exec",
        approvalId: "req-1",
        phase: "expired",
        title: "Exec approval",
        metadata: [],
        commandText: "echo hi",
      } as never,
      entry: { chatId: "9", messageId: "m1" },
    });

    expect(resolved).toEqual({
      kind: "update",
      payload: {
        text: [
          "✅ Exec approval resolved",
          "Canonical result: Denied",
          "Resolved by: telegram:9",
          "ID: req-1",
          "",
          "Command:",
          "echo hi",
        ].join("\n"),
      },
    });
    expect(expired).toEqual({
      kind: "update",
      payload: {
        text: [
          "⏱️ Exec approval expired",
          "Canonical result: Expired",
          "ID: req-1",
          "",
          "Command:",
          "echo hi",
        ].join("\n"),
      },
    });
  });

  it("updates the pending message and removes actions for terminal events", async () => {
    const editMessage = vi.fn().mockResolvedValue({
      ok: true,
      chatId: "9",
      messageId: "m1",
    });

    await telegramApprovalNativeRuntime.transport.updateEntry?.({
      cfg: {} as never,
      accountId: "default",
      context: {
        token: "tg-token",
        deps: { editMessage },
      },
      entry: { chatId: "9", messageId: "m1" },
      payload: { text: "Canonical result: <Denied>" },
      phase: "resolved",
    });

    expect(editMessage).toHaveBeenCalledWith("9", "m1", "Canonical result: &lt;Denied&gt;", {
      cfg: {},
      token: "tg-token",
      accountId: "default",
      textMode: "html",
      buttons: [],
    });
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

    expect(sendTyping).toHaveBeenCalledWith("-1003841603622", {
      cfg: {},
      token: "tg-token",
      accountId: "default",
      messageThreadId: 928,
    });
    expect(sendMessage).toHaveBeenCalledWith("-1003841603622", "pending", {
      cfg: {},
      token: "tg-token",
      accountId: "default",
      buttons: [],
      messageThreadId: 928,
    });
    expect(entry).toEqual({
      chatId: "-1003841603622",
      messageId: "m1",
    });
  });
});
