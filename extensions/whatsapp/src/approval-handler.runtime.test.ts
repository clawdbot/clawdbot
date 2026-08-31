// Whatsapp tests cover approval handler plugin behavior.
import { beforeEach, describe, expect, it } from "vitest";
import { whatsappApprovalNativeRuntime } from "./approval-handler.runtime.js";
import {
  clearWhatsAppApprovalReactionTargetsForTest,
  resolveWhatsAppApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";

describe("whatsappApprovalNativeRuntime", () => {
  beforeEach(() => clearWhatsAppApprovalReactionTargetsForTest());

  it("renders allowed thumbs-only reactions in pending exec approvals", async () => {
    const payload = await whatsappApprovalNativeRuntime.presentation.buildPendingPayload({
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

    expect(payload.reactionPayload.text).toContain("👍 Allow Once");
    expect(payload.reactionPayload.text).toContain("👎 Deny");
    expect(payload.reactionPayload.text).not.toContain("1️⃣ Allow Once");
    expect(payload.reactionPayload.text).not.toContain("2️⃣ Allow Always");
    expect(payload.reactionPayload.text).not.toContain("3️⃣ Deny");
    expect(payload.reactionPayload.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it("renders allowed thumbs-only reactions in pending plugin approvals", async () => {
    const payload = await whatsappApprovalNativeRuntime.presentation.buildPendingPayload({
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

    expect(payload.reactionPayload.text).toContain("Plugin approval required");
    expect(payload.reactionPayload.text).toContain(
      "Reply with: /approve plugin:abc allow-once|allow-always|deny",
    );
    expect(payload.reactionPayload.text).toContain("👍 Allow Once");
    expect(payload.reactionPayload.text).toContain("👎 Deny");
    expect(payload.reactionPayload.text).not.toContain("/approve <id>");
    expect(payload.reactionPayload.text).not.toContain("1️⃣ Allow Once");
    expect(payload.reactionPayload.text).not.toContain("2️⃣ Allow Always");
    expect(payload.reactionPayload.text).not.toContain("3️⃣ Deny");
    expect(payload.reactionPayload.allowedDecisions).toEqual([
      "allow-once",
      "allow-always",
      "deny",
    ]);
  });

  it("normalizes WhatsApp targets and carries account ids into prepared delivery", async () => {
    await expect(
      whatsappApprovalNativeRuntime.transport.prepareTarget({
        cfg: {} as never,
        accountId: "ops",
        context: { accountId: "ops" },
        plannedTarget: {
          surface: "origin",
          reason: "preferred",
          target: {
            to: "15551230000@s.whatsapp.net",
          },
        },
        request: {
          id: "exec-1",
          request: {
            command: "echo hi",
          },
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
          manualFallbackPayload: { text: "pending" },
          reactionPayload: {
            text: "pending",
            allowedDecisions: ["allow-once"],
            reactionBindings: [],
          },
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

  it("resolves the configured default account before binding native reactions", async () => {
    await expect(
      whatsappApprovalNativeRuntime.transport.prepareTarget({
        cfg: {
          channels: {
            whatsapp: {
              defaultAccount: "work",
              accounts: { work: {} },
            },
          },
        },
        plannedTarget: {
          surface: "origin",
          reason: "preferred",
          target: { to: "15551230000@s.whatsapp.net" },
        },
      } as never),
    ).resolves.toEqual({
      dedupeKey: expect.stringContaining("work:"),
      target: {
        to: "+15551230000",
        accountId: "work",
      },
    });
  });

  it("binds same-id native prompts to their lifecycle instances", async () => {
    for (const [messageId, instanceId] of [
      ["old-message", "old-instance"],
      ["current-message", "current-instance"],
    ] as const) {
      await expect(
        whatsappApprovalNativeRuntime.interactions!.bindPending!({
          entry: {
            accountId: "default",
            to: "+15551230000",
            remoteJid: "15551230000@s.whatsapp.net",
            messageId,
          },
          request: { id: "exec-reused", instanceId },
          view: {
            approvalKind: "exec",
            approvalId: "exec-reused",
            expiresAtMs: Date.now() + 60_000,
          },
          pendingPayload: {
            reactionPayload: { allowedDecisions: ["allow-once"] },
          },
        } as never),
      ).resolves.toBe(true);
      await expect(
        resolveWhatsAppApprovalReactionTargetWithPersistence({
          accountId: "default",
          remoteJid: "15551230000@s.whatsapp.net",
          messageId,
          reactionKey: "👍",
        }),
      ).resolves.toMatchObject({ approvalId: "exec-reused", instanceId });
    }
  });
});
