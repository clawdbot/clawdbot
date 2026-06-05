// Imessage tests cover approval handler plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { imessageApprovalNativeRuntime } from "./approval-handler.runtime.js";

const sendMock = vi.hoisted(() => ({
  sendMessageIMessage: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendMessageIMessage: sendMock.sendMessageIMessage,
}));

describe("imessageApprovalNativeRuntime", () => {
  it("renders shared reactions in pending exec approvals", async () => {
    const payload = await imessageApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: { accountId: "default" },
      request: {
        id: "exec-1",
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
        approvalId: "exec-1",
        commandText: "echo hi",
        actions: [
          {
            decision: "allow-once",
            label: "Allow Once",
            command: "/approve exec-1 allow-once",
            style: "success",
          },
          {
            decision: "deny",
            label: "Deny",
            command: "/approve exec-1 deny",
            style: "danger",
          },
        ],
      } as never,
    });

    expect(payload.text).toContain("👍 Allow Once");
    expect(payload.text).toContain("👎 Deny");
    expect(payload.text).not.toContain("1️⃣ Allow Once");
    expect(payload.text).not.toContain("2️⃣ Allow Always");
    expect(payload.text).not.toContain("3️⃣ Deny");
    expect(payload.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it("renders shared reactions in pending plugin approvals", async () => {
    const payload = await imessageApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: { accountId: "default" },
      request: {
        id: "plugin:abc",
        request: {
          title: "Allow Codex to use 1Password?",
          description: "Allow Codex to use 1Password?",
          pluginId: "openclaw-codex-app-server",
          toolName: "codex_mcp_tool_approval",
          severity: "warning",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "plugin",
      nowMs: 0,
      view: {
        approvalKind: "plugin",
        approvalId: "plugin:abc",
        title: "Plugin approval required",
        severity: "warning",
        actions: [
          {
            decision: "allow-once",
            label: "Allow Once",
            command: "/approve plugin:abc allow-once",
            style: "success",
          },
          {
            decision: "allow-always",
            label: "Allow Always",
            command: "/approve plugin:abc allow-always",
            style: "primary",
          },
          {
            decision: "deny",
            label: "Deny",
            command: "/approve plugin:abc deny",
            style: "danger",
          },
        ],
      } as never,
    });

    expect(payload.text).toContain("Plugin approval required");
    expect(payload.text).toContain("Reply with: /approve plugin:abc allow-once|allow-always|deny");
    expect(payload.text).toContain("👍 Allow Once");
    expect(payload.text).toContain("♾️ Allow Always");
    expect(payload.text).toContain("👎 Deny");
    expect(payload.text).not.toContain("/approve <id>");
    expect(payload.allowedDecisions).toEqual(["allow-once", "allow-always", "deny"]);
  });

  it("normalizes iMessage handle targets and carries account ids into prepared delivery", async () => {
    await expect(
      imessageApprovalNativeRuntime.transport.prepareTarget({
        cfg: {} as never,
        accountId: "ops",
        context: { accountId: "ops" },
        plannedTarget: {
          surface: "origin",
          reason: "preferred",
          target: {
            to: "+1 (555) 123-0000",
          },
        },
        request: {
          id: "exec-1",
          request: { command: "echo hi" },
          createdAtMs: 0,
          expiresAtMs: 60_000,
        },
        approvalKind: "exec",
        view: {
          approvalKind: "exec",
          approvalId: "exec-1",
          commandText: "echo hi",
          actions: [],
        } as never,
        pendingPayload: {
          text: "pending",
          allowedDecisions: ["allow-once"],
        },
      }),
    ).resolves.toEqual({
      dedupeKey: expect.any(String),
      target: {
        to: "+15551230000",
        accountId: "ops",
      },
    });
  });

  describe("deliverPending GUID-only binding", () => {
    beforeEach(() => {
      sendMock.sendMessageIMessage.mockReset();
    });

    const baseDeliverArgs = {
      cfg: {} as never,
      accountId: "default",
      context: { accountId: "default" },
      preparedTarget: { to: "+15551230000", accountId: "default" },
      plannedTarget: {
        surface: "origin" as const,
        reason: "preferred" as const,
        target: { to: "+15551230000" },
      },
      request: {
        id: "exec-1",
        request: { command: "echo hi" },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec" as const,
      view: {
        approvalKind: "exec",
        approvalId: "exec-1",
        commandText: "echo hi",
        actions: [],
      } as never,
      pendingPayload: {
        text: "Reply with: /approve exec-1 allow-once",
        allowedDecisions: ["allow-once" as const],
      },
    };

    it("refuses to bind when the bridge returns only a numeric ROWID", async () => {
      // Regression for ClawSweeper P1: native deliverPending must require a
      // GUID for the binding because inbound `reacted_to_guid` is always a
      // GUID — never the numeric ROWID. A bridge that returns just
      // { message_id: 12345 } has no usable approval-reaction id.
      sendMock.sendMessageIMessage.mockResolvedValue({
        messageId: "12345",
        sentText: "Reply with: /approve exec-1 allow-once",
        receipt: { kind: "text" } as never,
      });

      await expect(
        imessageApprovalNativeRuntime.transport.deliverPending(baseDeliverArgs),
      ).resolves.toBeNull();
    });

    it("binds against the GUID when the bridge returns one", async () => {
      sendMock.sendMessageIMessage.mockResolvedValue({
        messageId: "p:0/abc-123",
        guid: "p:0/abc-123",
        sentText: "Reply with: /approve exec-1 allow-once",
        receipt: { kind: "text" } as never,
      });

      await expect(
        imessageApprovalNativeRuntime.transport.deliverPending(baseDeliverArgs),
      ).resolves.toEqual({
        accountId: "default",
        to: "+15551230000",
        conversation: { handle: "+15551230000" },
        messageId: "p:0/abc-123",
      });
    });

    it("refuses to bind when the bridge returns 'unknown' or 'ok' placeholders", async () => {
      sendMock.sendMessageIMessage.mockResolvedValue({
        messageId: "ok",
        sentText: "Reply with: /approve exec-1 allow-once",
        receipt: { kind: "text" } as never,
      });

      await expect(
        imessageApprovalNativeRuntime.transport.deliverPending(baseDeliverArgs),
      ).resolves.toBeNull();
    });
  });

  it("preserves group chat targets when preparing delivery", async () => {
    await expect(
      imessageApprovalNativeRuntime.transport.prepareTarget({
        cfg: {} as never,
        accountId: "default",
        context: { accountId: "default" },
        plannedTarget: {
          surface: "approver-dm",
          reason: "preferred",
          target: {
            to: "chat_guid:iMessage;+;chat42",
          },
        },
        request: {
          id: "exec-1",
          request: { command: "echo hi" },
          createdAtMs: 0,
          expiresAtMs: 60_000,
        },
        approvalKind: "exec",
        view: {
          approvalKind: "exec",
          approvalId: "exec-1",
          commandText: "echo hi",
          actions: [],
        } as never,
        pendingPayload: {
          text: "pending",
          allowedDecisions: ["allow-once"],
        },
      }),
    ).resolves.toEqual({
      dedupeKey: expect.any(String),
      target: {
        to: "chat_guid:iMessage;+;chat42",
        accountId: "default",
      },
    });
  });
});
