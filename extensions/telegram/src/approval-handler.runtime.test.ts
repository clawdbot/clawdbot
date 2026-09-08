// Telegram tests cover approval handler plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { telegramApprovalNativeRuntime } from "./approval-handler.runtime.js";
import { buildTelegramCanonicalApprovalTerminalText } from "./approval-terminal.js";

type TelegramPayload = {
  text: string;
  buttons?: Array<Array<{ text: string; callback_data?: string }>>;
};

describe("telegramApprovalNativeRuntime", () => {
  it("subscribes to system-agent approval events", () => {
    expect(telegramApprovalNativeRuntime.eventKinds).toContain("system-agent");
  });

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

  it("renders a cancelled system-agent result as lifecycle cancellation", () => {
    expect(
      buildTelegramCanonicalApprovalTerminalText({
        result: {
          applied: true,
          approval: {
            id: "system-agent:cancelled",
            status: "cancelled",
            reason: "run-aborted",
            urlPath: "/approve/system-agent:cancelled",
            createdAtMs: 0,
            expiresAtMs: 60_000,
            resolvedAtMs: 1_000,
            presentation: {
              kind: "system-agent",
              title: "OpenClaw change",
              description: "Restart the Gateway",
              proposalHash: "a".repeat(64),
              allowedDecisions: ["allow-once", "deny"],
            },
          },
        },
        fallbackApprovalId: "system-agent:cancelled",
      }),
    ).toBe("⚠️ OpenClaw change was cancelled because its run ended. No change was made. Retry.");
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
    expect(payload.text).not.toContain("Scope:");
  });

  it("renders owner-declared plugin approval scope in pending text", async () => {
    const scope = {
      kind: "message-send" as const,
      target: "email",
      recipientCount: 3,
      recipients: ["alice@example.com"],
      audience: "external" as const,
    };
    const payload = (await telegramApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: { token: "tg-token" },
      request: {
        approvalKind: "plugin",
        id: "plugin:req-1",
        request: {
          title: "Send email",
          description: "Deliver the requested announcement.",
          scope,
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "plugin",
      nowMs: 0,
      view: {
        approvalKind: "plugin",
        phase: "pending",
        approvalId: "plugin:req-1",
        title: "Send email",
        description: "Deliver the requested announcement.",
        severity: "warning",
        scope,
        metadata: [],
        actions: [],
        expiresAtMs: 60_000,
      },
    })) as TelegramPayload;

    expect(payload.text).toContain(
      "Scope: Send to 3 recipients via email (external): alice@example.com, +2 more",
    );
  });

  it("renders a system-agent approval with an optional Control UI link", async () => {
    const payload = (await telegramApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {
        gateway: {
          publicOrigin: "https://control.example.com",
          controlUi: { basePath: "/openclaw/" },
        },
      } as never,
      accountId: "default",
      context: { token: "tg-token" },
      request: {
        id: "system-agent:change-1",
        request: {
          title: "OpenClaw change",
          description: "set config gateway.port to 19001",
          command: "set config gateway.port to 19001",
          proposalHash: "a".repeat(64),
          allowedDecisions: ["allow-once", "deny"],
          agentId: "main",
          sessionId: "delegation-1",
        },
        createdAtMs: 0,
        expiresAtMs: 120_000,
      },
      approvalKind: "system-agent",
      nowMs: 0,
      view: {
        approvalKind: "system-agent",
        approvalId: "system-agent:change-1",
        phase: "pending",
        title: "OpenClaw change requires approval",
        description: "set config gateway.port to 19001",
        metadata: [{ label: "Agent", value: "main" }],
        agentId: "main",
        commandText: "set config gateway.port to 19001",
        operationSummary: "set config gateway.port to 19001",
        actions: [
          {
            decision: "allow-once",
            label: "Allow Once",
            action: {
              type: "approval",
              approvalId: "system-agent:change-1",
              approvalKind: "system-agent",
              decision: "allow-once",
            },
            command: "/approve system-agent:change-1 allow-once",
            style: "success",
          },
          {
            decision: "deny",
            label: "Deny",
            action: {
              type: "approval",
              approvalId: "system-agent:change-1",
              approvalKind: "system-agent",
              decision: "deny",
            },
            command: "/approve system-agent:change-1 deny",
            style: "danger",
          },
        ],
        expiresAtMs: 120_000,
      },
    })) as TelegramPayload;

    expect(payload.text).toBe(
      [
        "🔒 OpenClaw change requires approval",
        "Change: set config gateway.port to 19001",
        "Agent: main",
        "Expires in: 2m",
      ].join("\n"),
    );
    expect(payload.buttons).toEqual([
      [
        {
          text: "Review in Control UI",
          url: "https://control.example.com/openclaw/approve/system-agent%3Achange-1",
        },
      ],
      [
        { text: "Allow Once", callback_data: "tga1:s:o:system-agent:change-1", style: "success" },
        { text: "Deny", callback_data: "tga1:s:d:system-agent:change-1", style: "danger" },
      ],
    ]);
  });

  it("omits the Control UI button without a configured public origin", async () => {
    const payload = await telegramApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: { token: "tg-token" },
      request: {
        id: "system-agent:change-2",
        request: {
          title: "OpenClaw change",
          description: "restart the Gateway",
          command: "restart the Gateway",
          proposalHash: "b".repeat(64),
          allowedDecisions: ["allow-once", "deny"],
          sessionId: "delegation-2",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "system-agent",
      nowMs: 0,
      view: {
        approvalKind: "system-agent",
        approvalId: "system-agent:change-2",
        phase: "pending",
        title: "OpenClaw change requires approval",
        metadata: [],
        commandText: "restart the Gateway",
        operationSummary: "restart the Gateway",
        actions: [],
        expiresAtMs: 60_000,
      },
    });
    expect(payload.buttons).toEqual([]);
  });

  it("omits the Control UI button when the Control UI is disabled", async () => {
    const payload = await telegramApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {
        gateway: {
          publicOrigin: "https://control.example.com",
          controlUi: { enabled: false },
        },
      } as never,
      accountId: "default",
      context: { token: "tg-token" },
      request: {
        id: "system-agent:change-disabled-ui",
        request: {
          title: "OpenClaw change",
          description: "restart the Gateway",
          command: "restart the Gateway",
          proposalHash: "e".repeat(64),
          allowedDecisions: ["allow-once", "deny"],
          sessionId: "delegation-disabled-ui",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "system-agent",
      nowMs: 0,
      view: {
        approvalKind: "system-agent",
        approvalId: "system-agent:change-disabled-ui",
        phase: "pending",
        title: "OpenClaw change requires approval",
        metadata: [],
        commandText: "restart the Gateway",
        operationSummary: "restart the Gateway",
        actions: [],
        expiresAtMs: 60_000,
      },
    });
    expect(payload.buttons).toEqual([]);
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

  it.each([
    {
      name: "applied",
      decision: "allow-once",
      applicationStatus: "applied",
      summary: "set config gateway.port to 19001",
      expected: "✅ OpenClaw change approved and applied: set config gateway.port to 19001",
    },
    {
      name: "denied and not applied",
      decision: "deny",
      applicationStatus: "not-applied",
      summary: "set config gateway.port to 19001",
      expected: "❌ OpenClaw change denied. No change was made.",
    },
    {
      name: "applied with a bounded UTF-16 summary",
      decision: "allow-once",
      applicationStatus: "applied",
      summary: ` ${"x".repeat(2798)}😀tail `,
      expected: `✅ OpenClaw change approved and applied: ${"x".repeat(2798)}…`,
    },
  ] as const)(
    "renders exact system-agent terminal receipts: $name",
    async ({ decision, applicationStatus, summary, expected }) => {
      const request = {
        approvalKind: "system-agent" as const,
        id: "system-agent:change-3",
        request: {
          title: "OpenClaw change",
          description: summary,
          command: summary,
          proposalHash: "c".repeat(64),
          allowedDecisions: ["allow-once", "deny"] as const,
          sessionId: "delegation-3",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      };
      await expect(
        telegramApprovalNativeRuntime.presentation.buildResolvedResult({
          cfg: {} as never,
          accountId: "default",
          context: { token: "tg-token" },
          request,
          resolved: {
            id: request.id,
            decision,
            ts: 1,
            applicationStatus,
          },
          view: {
            approvalKind: "system-agent",
            approvalId: request.id,
            phase: "resolved",
            title: "OpenClaw change",
            metadata: [],
            commandText: summary,
            operationSummary: summary,
            decision,
            applicationStatus,
          },
          entry: { chatId: "9", messageId: "m1" },
        }),
      ).resolves.toEqual({
        kind: "update",
        payload: {
          text: expected,
        },
      });
    },
  );

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
      request: {
        id: "approval-1",
        request: { command: "echo hi" },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec",
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

  it("sends one terminal origin result and releases its dedupe entry after finalization", async () => {
    const editMessage = vi.fn().mockResolvedValue({ ok: true });
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const request = {
      approvalKind: "system-agent" as const,
      id: "system-agent:origin-followup",
      request: {
        title: "OpenClaw change",
        description: "restart the Gateway",
        command: "restart the Gateway",
        proposalHash: "d".repeat(64),
        allowedDecisions: ["allow-once", "deny"] as const,
        sessionId: "delegation-origin-followup",
        turnSourceChannel: "telegram",
        turnSourceTo: "1234",
        turnSourceThreadId: 42,
      },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    };

    await telegramApprovalNativeRuntime.transport.updateEntry?.({
      cfg: {} as never,
      accountId: "default",
      context: { token: "tg-token", deps: { editMessage, sendMessage } },
      entry: { chatId: "5678", messageId: "m1" },
      request,
      approvalKind: "system-agent",
      payload: { text: "✅ OpenClaw change approved. Applying: restart the Gateway" },
      phase: "resolved",
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "1234",
      "✅ OpenClaw change approved. Applying: restart the Gateway",
      {
        cfg: {},
        token: "tg-token",
        accountId: "default",
        textMode: "html",
        messageThreadId: 42,
      },
    );

    await telegramApprovalNativeRuntime.transport.updateEntry?.({
      cfg: {} as never,
      accountId: "default",
      context: { token: "tg-token", deps: { editMessage, sendMessage } },
      entry: { chatId: "9012", messageId: "m2" },
      request,
      approvalKind: "system-agent",
      payload: { text: "✅ OpenClaw change approved. Applying: restart the Gateway" },
      phase: "resolved",
    });
    expect(sendMessage).toHaveBeenCalledOnce();

    telegramApprovalNativeRuntime.observe?.onFinalized?.({
      cfg: {} as never,
      accountId: "default",
      context: { token: "tg-token" },
      request,
      approvalKind: "system-agent",
      phase: "resolved",
    });

    await telegramApprovalNativeRuntime.transport.updateEntry?.({
      cfg: {} as never,
      accountId: "default",
      context: { token: "tg-token", deps: { editMessage, sendMessage } },
      entry: { chatId: "9013", messageId: "m3" },
      request,
      approvalKind: "system-agent",
      payload: { text: "✅ OpenClaw change approved. Applying: restart the Gateway" },
      phase: "resolved",
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("sends the origin result when the approver card edit fails", async () => {
    const editMessage = vi.fn().mockRejectedValue(new Error("message was deleted"));
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const request = {
      approvalKind: "system-agent" as const,
      id: "system-agent:origin-edit-failure",
      request: {
        title: "OpenClaw change",
        description: "restart the Gateway",
        command: "restart the Gateway",
        proposalHash: "f".repeat(64),
        allowedDecisions: ["allow-once", "deny"] as const,
        sessionId: "delegation-origin-edit-failure",
        turnSourceChannel: "telegram",
        turnSourceTo: "1234",
      },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    };

    await expect(
      telegramApprovalNativeRuntime.transport.updateEntry?.({
        cfg: {} as never,
        accountId: "default",
        context: { token: "tg-token", deps: { editMessage, sendMessage } },
        entry: { chatId: "5678", messageId: "m1" },
        request,
        approvalKind: "system-agent",
        payload: { text: "⚠️ OpenClaw change approved, but it was not applied." },
        phase: "resolved",
      }),
    ).rejects.toThrow("message was deleted");
    expect(sendMessage).toHaveBeenCalledWith(
      "1234",
      "⚠️ OpenClaw change approved, but it was not applied.",
      {
        cfg: {},
        token: "tg-token",
        accountId: "default",
        textMode: "html",
      },
    );
  });

  it("sends origin notices only through the originating Telegram account", async () => {
    const editMessage = vi.fn().mockResolvedValue({ ok: true });
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const request = {
      approvalKind: "system-agent" as const,
      id: "system-agent:origin-account",
      request: {
        title: "OpenClaw change",
        description: "restart the Gateway",
        command: "restart the Gateway",
        proposalHash: "g".repeat(64),
        allowedDecisions: ["allow-once", "deny"] as const,
        sessionId: "delegation-origin-account",
        turnSourceChannel: "telegram",
        turnSourceTo: "1234",
        turnSourceAccountId: "origin",
      },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    };
    const payload = { text: "✅ OpenClaw change approved and applied." };

    await telegramApprovalNativeRuntime.transport.updateEntry?.({
      cfg: {} as never,
      accountId: "forwarding",
      context: { token: "tg-token", deps: { editMessage, sendMessage } },
      entry: { chatId: "5678", messageId: "m1" },
      request,
      approvalKind: "system-agent",
      payload,
      phase: "resolved",
    });
    expect(sendMessage).not.toHaveBeenCalled();

    await telegramApprovalNativeRuntime.transport.updateEntry?.({
      cfg: {} as never,
      accountId: "origin",
      context: { token: "tg-token", deps: { editMessage, sendMessage } },
      entry: { chatId: "5678", messageId: "m1" },
      request,
      approvalKind: "system-agent",
      payload,
      phase: "resolved",
    });
    expect(sendMessage).toHaveBeenCalledOnce();
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

  it("passes channel Direct Messages topic ids to approval delivery", async () => {
    const sendTyping = vi.fn().mockResolvedValue({ ok: true });
    const sendMessage = vi.fn().mockResolvedValue({
      chatId: "-1003841603622",
      messageId: "m1",
    });

    await telegramApprovalNativeRuntime.transport.deliverPending?.({
      cfg: {} as never,
      accountId: "default",
      context: {
        token: "tg-token",
        deps: { sendTyping, sendMessage },
      },
      plannedTarget: {
        surface: "origin",
        reason: "preferred",
        target: {
          to: "-1003841603622:direct-topic:77",
        },
      },
      preparedTarget: {
        chatId: "-1003841603622",
        directMessagesTopicId: 77,
      },
      request: {
        id: "req-direct-topic",
        request: { command: "echo hi" },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec",
      view: {
        approvalKind: "exec",
        approvalId: "req-direct-topic",
        commandText: "echo hi",
        actions: [],
      } as never,
      pendingPayload: {
        text: "pending",
        buttons: [],
      },
    });

    expect(sendMessage).toHaveBeenCalledWith("-1003841603622", "pending", {
      cfg: {},
      token: "tg-token",
      accountId: "default",
      buttons: [],
      directMessagesTopicId: 77,
    });
  });
});
