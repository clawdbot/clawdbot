import type { ButtonInteraction, ComponentData } from "@buape/carbon";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveApprovalOverGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/approval-gateway-runtime")>();
  return {
    ...actual,
    resolveApprovalOverGateway: resolveApprovalOverGatewayMock,
  };
});

import {
  ExecApprovalButton,
  buildExecApprovalCustomId,
  createDiscordExecApprovalButtonContext,
  extractDiscordChannelId,
  parseExecApprovalData,
} from "./exec-approvals.js";

function buildConfig(
  execApprovals?: NonNullable<NonNullable<OpenClawConfig["channels"]>["discord"]>["execApprovals"],
): OpenClawConfig {
  return {
    channels: {
      discord: {
        token: "discord-token",
        execApprovals,
      },
    },
  } as OpenClawConfig;
}

function createInteraction(overrides?: Partial<ButtonInteraction>): ButtonInteraction {
  return {
    userId: "123",
    reply: vi.fn(),
    acknowledge: vi.fn(),
    followUp: vi.fn(),
    ...overrides,
  } as unknown as ButtonInteraction;
}

describe("discord exec approval monitor helpers", () => {
  beforeEach(() => {
    resolveApprovalOverGatewayMock.mockReset();
  });

  it("encodes approval ids into custom ids", () => {
    expect(buildExecApprovalCustomId("abc-123", "allow-once")).toBe(
      "execapproval:id=abc-123;action=allow-once",
    );
    expect(buildExecApprovalCustomId("abc=123;test", "deny")).toBe(
      "execapproval:id=abc%3D123%3Btest;action=deny",
    );
  });

  it("parses valid button data and rejects invalid payloads", () => {
    expect(parseExecApprovalData({ id: "abc-123", action: "allow-once" })).toEqual({
      approvalId: "abc-123",
      action: "allow-once",
    });
    expect(
      parseExecApprovalData({
        id: "abc%3D123%3Btest",
        action: "allow-always",
      }),
    ).toEqual({
      approvalId: "abc=123;test",
      action: "allow-always",
    });
    expect(parseExecApprovalData({ id: "abc", action: "invalid" })).toBeNull();
    expect(parseExecApprovalData({ action: "deny" } as ComponentData)).toBeNull();
  });

  it("extracts discord channel ids from session keys", () => {
    expect(extractDiscordChannelId("agent:main:discord:channel:123456789")).toBe("123456789");
    expect(extractDiscordChannelId("agent:main:discord:group:222333444")).toBe("222333444");
    expect(extractDiscordChannelId("agent:main:telegram:channel:123456789")).toBeNull();
    expect(extractDiscordChannelId("")).toBeNull();
  });

  it("rejects invalid approval button payloads", async () => {
    const interaction = createInteraction();
    const button = new ExecApprovalButton({
      getApprovers: () => ["123"],
      resolveApproval: async () => ({ ok: true }),
    });

    await button.run(interaction, { id: "", action: "" });

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "This approval is no longer valid.",
      ephemeral: true,
    });
  });

  it("blocks non-approvers from approving", async () => {
    const interaction = createInteraction({ userId: "999" });
    const button = new ExecApprovalButton({
      getApprovers: () => ["123"],
      resolveApproval: async () => ({ ok: true }),
    });

    await button.run(interaction, { id: "abc", action: "allow-once" });

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "⛔ You are not authorized to approve exec requests.",
      ephemeral: true,
    });
  });

  it("acknowledges and resolves valid approval clicks", async () => {
    const interaction = createInteraction();
    const resolveApproval = vi.fn(async () => ({ ok: true }) as const);
    const button = new ExecApprovalButton({
      getApprovers: () => ["123"],
      resolveApproval,
    });

    await button.run(interaction, { id: "abc", action: "allow-once" });

    expect(interaction.acknowledge).toHaveBeenCalled();
    expect(resolveApproval).toHaveBeenCalledWith("abc", "allow-once");
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("shows a follow-up when gateway resolution fails", async () => {
    const interaction = createInteraction();
    const button = new ExecApprovalButton({
      getApprovers: () => ["123"],
      resolveApproval: async () => ({ ok: false, reason: "error" }),
    });

    await button.run(interaction, { id: "abc", action: "deny" });

    expect(interaction.followUp).toHaveBeenCalledWith({
      content:
        "Failed to submit approval decision for **Denied**. The request may have expired or already been resolved.",
      ephemeral: true,
    });
  });

  it("keeps already-resolved approval clicks quiet", async () => {
    const interaction = createInteraction();
    const button = new ExecApprovalButton({
      getApprovers: () => ["123"],
      resolveApproval: async () => ({ ok: false, reason: "not-found" }),
    });

    await button.run(interaction, { id: "abc", action: "allow-once" });

    expect(interaction.acknowledge).toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("builds button context from config and routes resolution over gateway", async () => {
    const cfg = buildConfig({ enabled: true, approvers: ["123"] });
    resolveApprovalOverGatewayMock.mockResolvedValue(undefined);
    const ctx = createDiscordExecApprovalButtonContext({
      cfg,
      accountId: "default",
      config: { enabled: true, approvers: ["123"] },
      gatewayUrl: "ws://127.0.0.1:18789",
    });

    expect(ctx.getApprovers()).toEqual(["123"]);
    await expect(ctx.resolveApproval("abc", "allow-once")).resolves.toEqual({ ok: true });
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith({
      cfg,
      approvalId: "abc",
      decision: "allow-once",
      gatewayUrl: "ws://127.0.0.1:18789",
      clientDisplayName: "Discord approval (default)",
    });
  });

  it("returns false when gateway resolution throws", async () => {
    resolveApprovalOverGatewayMock.mockRejectedValue(new Error("boom"));
    const ctx = createDiscordExecApprovalButtonContext({
      cfg: buildConfig({ enabled: true, approvers: ["123"] }),
      accountId: "default",
      config: { enabled: true, approvers: ["123"] },
    });

    await expect(ctx.resolveApproval("abc", "allow-once")).resolves.toEqual({
      ok: false,
      reason: "error",
    });
  });

  it("classifies structured approval-not-found gateway errors as stale clicks", async () => {
    const err = Object.assign(new Error("unknown or expired approval id"), {
      gatewayCode: "INVALID_REQUEST",
      details: { reason: "APPROVAL_NOT_FOUND" },
    });
    resolveApprovalOverGatewayMock.mockRejectedValue(err);
    const ctx = createDiscordExecApprovalButtonContext({
      cfg: buildConfig({ enabled: true, approvers: ["123"] }),
      accountId: "default",
      config: { enabled: true, approvers: ["123"] },
    });

    await expect(ctx.resolveApproval("abc", "allow-once")).resolves.toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("keeps message-only approval-not-found errors visible", async () => {
    resolveApprovalOverGatewayMock.mockRejectedValue(new Error("unknown or expired approval id"));
    const ctx = createDiscordExecApprovalButtonContext({
      cfg: buildConfig({ enabled: true, approvers: ["123"] }),
      accountId: "default",
      config: { enabled: true, approvers: ["123"] },
    });

    await expect(ctx.resolveApproval("abc", "allow-once")).resolves.toEqual({
      ok: false,
      reason: "error",
    });
  });
});
