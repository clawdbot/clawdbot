// Discord tests cover exec approvals plugin behavior.
import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildExecApprovalCustomId, parseExecApprovalData } from "../approval-custom-id.js";
import { parseCustomId, type ButtonInteraction, type ComponentData } from "../internal/discord.js";

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
  createDiscordExecApprovalButtonContext,
  createExecApprovalButton,
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
    editReply: vi.fn(),
    followUp: vi.fn(),
    ...overrides,
  } as unknown as ButtonInteraction;
}

function createApprovalResolution(params?: {
  id?: string;
  applied?: boolean;
  status?: "allowed" | "denied" | "expired" | "cancelled";
  decision?: "allow-once" | "allow-always" | "deny";
}): ApprovalResolveResult {
  const status = params?.status ?? "allowed";
  return {
    applied: params?.applied ?? true,
    approval: {
      id: params?.id ?? "abc",
      status,
      ...(status === "allowed" ? { decision: params?.decision ?? "allow-once" } : {}),
      ...(status === "denied" ? { decision: "deny" } : {}),
    },
  } as ApprovalResolveResult;
}

describe("discord exec approval monitor helpers", () => {
  beforeEach(() => {
    resolveApprovalOverGatewayMock.mockReset();
  });

  it.each([
    ["exec", "plugin:looks-like-plugin", "allow-once"],
    ["plugin", "plain-plugin-id", "deny"],
  ] as const)("round-trips %s approval custom ids", (approvalKind, approvalId, action) => {
    const customId = buildExecApprovalCustomId(approvalId, approvalKind, action);
    const parsed = parseCustomId(customId);

    expect(parsed.key).toBe("execapproval");
    expect(parseExecApprovalData(parsed.data)).toEqual({
      approvalId,
      approvalKind,
      action,
    });
  });

  it("rejects malformed or ownerless button payloads", () => {
    expect(parseExecApprovalData({ kind: "exec", id: "abc", action: "invalid" })).toBeNull();
    expect(parseExecApprovalData({ kind: "tool", id: "abc", action: "deny" })).toBeNull();
    expect(parseExecApprovalData({ id: "abc", action: "deny" })).toBeNull();
    expect(parseExecApprovalData({ kind: "exec", id: "%zz", action: "deny" })).toBeNull();
    expect(parseExecApprovalData({ kind: "plugin", action: "deny" } as ComponentData)).toBeNull();
  });

  it("rejects invalid approval button payloads", async () => {
    const interaction = createInteraction();
    const button = createExecApprovalButton({
      getApprovers: () => ["123"],
      resolveApproval: async () => ({ ok: true, resolution: createApprovalResolution() }),
    });

    await button.run(interaction, { id: "", action: "" });

    expect(interaction["reply"]).toHaveBeenCalledWith({
      content: "This approval is no longer valid.",
      ephemeral: true,
    });
  });

  it("blocks non-approvers from approving", async () => {
    const interaction = createInteraction({ userId: "999" });
    const button = createExecApprovalButton({
      getApprovers: () => ["123"],
      resolveApproval: async () => ({ ok: true, resolution: createApprovalResolution() }),
    });

    await button.run(interaction, { kind: "exec", id: "abc", action: "allow-once" });

    expect(interaction["reply"]).toHaveBeenCalledWith({
      content: "⛔ You are not authorized to approve requests.",
      ephemeral: true,
    });
  });

  it.each(["exec", "plugin"] as const)(
    "acknowledges and resolves valid %s approval clicks",
    async (approvalKind) => {
      const editReply = vi.fn();
      const interaction = createInteraction({ editReply });
      const resolveApproval = vi.fn(
        async () =>
          ({
            ok: true,
            resolution: createApprovalResolution(),
          }) as const,
      );
      const button = createExecApprovalButton({
        getApprovers: () => ["123"],
        resolveApproval,
      });

      await button.run(interaction, { kind: approvalKind, id: "abc", action: "allow-once" });

      expect(interaction["acknowledge"]).toHaveBeenCalled();
      expect(resolveApproval).toHaveBeenCalledWith("abc", approvalKind, "allow-once");
      expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain("Approval resolved");
      expect(interaction["followUp"]).not.toHaveBeenCalled();
    },
  );

  it("shows the canonical result when the clicked message cannot be edited", async () => {
    const interaction = createInteraction({
      editReply: vi.fn(async () => {
        throw new Error("message edit failed");
      }),
    });
    const button = createExecApprovalButton({
      getApprovers: () => ["123"],
      resolveApproval: async () => ({
        ok: true,
        resolution: createApprovalResolution({
          applied: true,
          status: "allowed",
          decision: "allow-once",
        }),
      }),
    });

    await button.run(interaction, { kind: "exec", id: "abc", action: "allow-once" });

    expect(interaction["followUp"]).toHaveBeenCalledWith({
      content: "Approval resolved: Allowed once.",
      ephemeral: true,
    });
  });

  it("cleans stale controls and shows the canonical winner after losing the race", async () => {
    const editReply = vi.fn();
    const interaction = createInteraction({ editReply });
    const resolution = createApprovalResolution({
      id: "plain-plugin-id",
      applied: false,
      status: "denied",
      decision: "deny",
    });
    resolveApprovalOverGatewayMock.mockResolvedValueOnce(resolution);
    const button = createExecApprovalButton(
      createDiscordExecApprovalButtonContext({
        cfg: buildConfig({ enabled: true, approvers: ["123"] }),
        accountId: "default",
        config: { enabled: true, approvers: ["123"] },
      }),
    );

    await button.run(interaction, {
      kind: "plugin",
      id: "plain-plugin-id",
      action: "allow-once",
    });

    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "plain-plugin-id",
        approvalKind: "plugin",
        decision: "allow-once",
      }),
    );
    expect(interaction["editReply"]).toHaveBeenCalledTimes(1);
    const terminalPayload = editReply.mock.calls[0]?.[0];
    expect(JSON.stringify(terminalPayload)).toContain("Approval already resolved");
    expect(JSON.stringify(terminalPayload)).toContain("Canonical result: **Denied**");
    expect(JSON.stringify(terminalPayload)).not.toContain("execapproval");
    expect(interaction["followUp"]).toHaveBeenCalledWith({
      content: "This approval was already resolved: Denied.",
      ephemeral: true,
    });
  });

  it("shows a follow-up when gateway resolution fails", async () => {
    const interaction = createInteraction();
    const button = createExecApprovalButton({
      getApprovers: () => ["123"],
      resolveApproval: async () => ({ ok: false, reason: "error" }),
    });

    await button.run(interaction, { kind: "plugin", id: "abc", action: "deny" });

    expect(interaction["followUp"]).toHaveBeenCalledWith({
      content:
        "Failed to submit approval decision for **Denied**. The request may have expired or already been resolved.",
      ephemeral: true,
    });
  });

  it("shows a follow-up for already-resolved approval clicks", async () => {
    const interaction = createInteraction();
    const button = createExecApprovalButton({
      getApprovers: () => ["123"],
      resolveApproval: async () => ({ ok: false, reason: "not-found" }),
    });

    await button.run(interaction, { kind: "exec", id: "abc", action: "allow-once" });

    expect(interaction["acknowledge"]).toHaveBeenCalled();
    expect(interaction["followUp"]).toHaveBeenCalledWith({
      content:
        "That approval request is no longer pending. It may have expired or already been resolved.",
      ephemeral: true,
    });
  });

  it.each(["exec", "plugin"] as const)(
    "routes %s button resolutions through the canonical gateway method",
    async (approvalKind) => {
      const cfg = buildConfig({ enabled: true, approvers: ["123"] });
      const resolution = createApprovalResolution();
      resolveApprovalOverGatewayMock.mockResolvedValue(resolution);
      const ctx = createDiscordExecApprovalButtonContext({
        cfg,
        accountId: "default",
        config: { enabled: true, approvers: ["123"] },
        gatewayUrl: "ws://127.0.0.1:18789",
      });

      expect(ctx.getApprovers()).toEqual(["123"]);
      await expect(ctx.resolveApproval("abc", approvalKind, "allow-once")).resolves.toEqual({
        ok: true,
        resolution,
      });
      expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith({
        cfg,
        approvalId: "abc",
        approvalKind,
        decision: "allow-once",
        gatewayUrl: "ws://127.0.0.1:18789",
        clientDisplayName: "Discord approval (default)",
      });
    },
  );

  it("returns false when gateway resolution throws", async () => {
    resolveApprovalOverGatewayMock.mockRejectedValue(new Error("boom"));
    const ctx = createDiscordExecApprovalButtonContext({
      cfg: buildConfig({ enabled: true, approvers: ["123"] }),
      accountId: "default",
      config: { enabled: true, approvers: ["123"] },
    });

    await expect(ctx.resolveApproval("abc", "exec", "allow-once")).resolves.toEqual({
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

    await expect(ctx.resolveApproval("abc", "plugin", "allow-once")).resolves.toEqual({
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

    await expect(ctx.resolveApproval("abc", "exec", "allow-once")).resolves.toEqual({
      ok: false,
      reason: "error",
    });
  });
});
