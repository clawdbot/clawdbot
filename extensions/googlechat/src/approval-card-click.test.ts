import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGoogleChatApprovalActionParameters,
  clearGoogleChatApprovalCardBindingsForTest,
  registerGoogleChatApprovalCardBinding,
} from "./approval-card-actions.js";
import { maybeHandleGoogleChatApprovalCardClick } from "./approval-card-click.js";
import type { WebhookTarget } from "./monitor-types.js";
import type { GoogleChatEvent } from "./types.js";

const resolveApprovalOverGateway = vi.hoisted(() => vi.fn());
const updateGoogleChatMessage = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway,
}));
vi.mock("./api.js", () => ({ updateGoogleChatMessage }));

type ApprovalDecision = "allow-once" | "allow-always" | "deny";

function createApprovalResolveResult(params: {
  applied: boolean;
  approvalId: string;
  approvalKind: "exec" | "plugin";
  decision: ApprovalDecision;
}): ApprovalResolveResult {
  const presentation =
    params.approvalKind === "exec"
      ? {
          kind: "exec" as const,
          commandText: "echo hi",
          commandPreview: null,
          allowedDecisions: ["allow-once" as const, "deny" as const],
        }
      : {
          kind: "plugin" as const,
          title: "Plugin request",
          description: "Allow this plugin action.",
          severity: "info" as const,
          allowedDecisions: ["allow-once" as const, "deny" as const],
        };
  const common = {
    id: params.approvalId,
    urlPath: `/approve/${encodeURIComponent(params.approvalId)}`,
    createdAtMs: 1,
    expiresAtMs: 10_000,
    resolvedAtMs: 2,
    reason: "user" as const,
    presentation,
  };
  return params.decision === "deny"
    ? {
        applied: params.applied,
        approval: { ...common, status: "denied", decision: "deny" },
      }
    : {
        applied: params.applied,
        approval: { ...common, status: "allowed", decision: params.decision },
      };
}

function createTarget(): WebhookTarget {
  return {
    account: {
      accountId: "default",
      enabled: true,
      credentialSource: "inline",
      config: {
        dm: { allowFrom: ["users/123"] },
      },
    },
    config: {
      channels: {
        googlechat: {
          dm: { allowFrom: ["users/123"] },
        },
      },
    },
    runtime: { log: vi.fn(), error: vi.fn() },
    core: {} as never,
    path: "/googlechat",
    mediaMaxMb: 20,
  };
}

function createCardClickEvent(token: string, userName = "users/123"): GoogleChatEvent {
  return {
    type: "CARD_CLICKED",
    space: { name: "spaces/AAA" },
    message: { name: "spaces/AAA/messages/msg-1" },
    user: { name: userName },
    action: {
      actionMethodName: "openclaw.approval",
      parameters: buildGoogleChatApprovalActionParameters(token),
    },
  };
}

describe("maybeHandleGoogleChatApprovalCardClick", () => {
  beforeEach(() => {
    clearGoogleChatApprovalCardBindingsForTest();
    resolveApprovalOverGateway
      .mockReset()
      .mockImplementation(
        (params: {
          approvalId: string;
          approvalKind: "exec" | "plugin";
          decision: ApprovalDecision;
        }) =>
          Promise.resolve(
            createApprovalResolveResult({
              applied: true,
              approvalId: params.approvalId,
              approvalKind: params.approvalKind,
              decision: params.decision,
            }),
          ),
      );
    updateGoogleChatMessage.mockReset().mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-1",
    });
  });

  it("authorizes the Chat actor and resolves the bound approval over the gateway", async () => {
    registerGoogleChatApprovalCardBinding({
      token: "token-1",
      accountId: "default",
      approvalId: "approval-1",
      approvalKind: "exec",
      decision: "allow-once",
      allowedDecisions: ["allow-once", "deny"],
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      expiresAtMs: Date.now() + 60_000,
    });

    const target = createTarget();
    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: createCardClickEvent("token-1"),
        target,
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      approvalId: "approval-1",
      approvalKind: "exec",
      decision: "allow-once",
      senderId: "users/123",
      clientDisplayName: "Google Chat approval (users/123)",
    });
    expect(updateGoogleChatMessage).toHaveBeenCalledWith({
      account: target.account,
      messageName: "spaces/AAA/messages/msg-1",
      cardsV2: expect.any(Array),
    });
    const cardJson = JSON.stringify(updateGoogleChatMessage.mock.calls[0]?.[0]);
    expect(cardJson).toContain("Exec Approval: Allowed once");
    expect(cardJson).toContain("Resolved by this action");
    expect(cardJson).not.toContain("buttonList");
  });

  it("accepts add-on clicks that only carry approval token parameters", async () => {
    registerGoogleChatApprovalCardBinding({
      token: "token-addon",
      accountId: "default",
      approvalId: "approval-addon",
      approvalKind: "exec",
      decision: "allow-once",
      allowedDecisions: ["allow-once", "deny"],
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: {
          type: "CARD_CLICKED",
          space: { name: "spaces/AAA" },
          message: { name: "spaces/AAA/messages/msg-1" },
          user: { name: "users/123" },
          commonEventObject: {
            parameters: {
              openclaw_action: "approval",
              token: "token-addon",
            },
          },
        },
        target: createTarget(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-addon",
        decision: "allow-once",
      }),
    );
  });

  it("accepts standard cardsV2 clicks with common parameters", async () => {
    registerGoogleChatApprovalCardBinding({
      token: "token-common",
      accountId: "default",
      approvalId: "approval-common",
      approvalKind: "plugin",
      decision: "deny",
      allowedDecisions: ["allow-once", "deny"],
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: {
          type: "CARD_CLICKED",
          space: { name: "spaces/AAA" },
          message: { name: "spaces/AAA/messages/msg-1" },
          user: { name: "users/123" },
          common: {
            invokedFunction: "openclaw.approval",
            parameters: {
              openclaw_action: "approval",
              token: "token-common",
            },
          },
        },
        target: createTarget(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-common",
        approvalKind: "plugin",
        decision: "deny",
      }),
    );
  });

  it("accepts endpoint URL invoked functions for app-url card actions", async () => {
    registerGoogleChatApprovalCardBinding({
      token: "token-url",
      accountId: "default",
      approvalId: "approval-url",
      approvalKind: "exec",
      decision: "allow-once",
      allowedDecisions: ["allow-once", "deny"],
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: {
          type: "CARD_CLICKED",
          space: { name: "spaces/AAA" },
          message: { name: "spaces/AAA/messages/msg-1" },
          user: { name: "users/123" },
          commonEventObject: {
            invokedFunction: "https://chat-app.example.test/googlechat",
            parameters: {
              openclaw_action: "approval",
              token: "token-url",
            },
          },
        },
        target: createTarget(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-url",
        decision: "allow-once",
      }),
    );
  });

  it("does not consume the token when an unauthorized user clicks", async () => {
    registerGoogleChatApprovalCardBinding({
      token: "token-2",
      accountId: "default",
      approvalId: "plugin:approval-2",
      approvalKind: "plugin",
      decision: "deny",
      allowedDecisions: ["allow-once", "deny"],
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: createCardClickEvent("token-2", "users/999"),
        target: createTarget(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();

    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: createCardClickEvent("token-2", "users/123"),
        target: createTarget(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "plugin:approval-2",
        approvalKind: "plugin",
        decision: "deny",
      }),
    );
  });

  it("keeps the token retryable when gateway resolution fails", async () => {
    registerGoogleChatApprovalCardBinding({
      token: "token-retry",
      accountId: "default",
      approvalId: "approval-retry",
      approvalKind: "exec",
      decision: "allow-once",
      allowedDecisions: ["allow-once", "deny"],
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      expiresAtMs: Date.now() + 60_000,
    });
    resolveApprovalOverGateway.mockRejectedValueOnce(new Error("gateway unavailable"));

    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: createCardClickEvent("token-retry"),
        target: createTarget(),
      }),
    ).rejects.toThrow("gateway unavailable");

    resolveApprovalOverGateway.mockResolvedValueOnce(
      createApprovalResolveResult({
        applied: true,
        approvalId: "approval-retry",
        approvalKind: "exec",
        decision: "allow-once",
      }),
    );
    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: createCardClickEvent("token-retry"),
        target: createTarget(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(2);
  });

  it("reports the canonical winner when another surface resolves first", async () => {
    registerGoogleChatApprovalCardBinding({
      token: "token-loser",
      accountId: "default",
      approvalId: "approval-loser",
      approvalKind: "exec",
      decision: "deny",
      allowedDecisions: ["allow-once", "deny"],
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      expiresAtMs: Date.now() + 60_000,
    });
    resolveApprovalOverGateway.mockResolvedValueOnce(
      createApprovalResolveResult({
        applied: false,
        approvalId: "approval-loser",
        approvalKind: "exec",
        decision: "allow-once",
      }),
    );
    const target = createTarget();

    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: createCardClickEvent("token-loser"),
        target,
      }),
    ).resolves.toBe(true);

    expect(target.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "approval already resolved id=approval-loser status=allowed decision=allow-once",
      ),
    );
    const cardJson = JSON.stringify(updateGoogleChatMessage.mock.calls[0]?.[0]);
    expect(cardJson).toContain("Exec Approval: Allowed once");
    expect(cardJson).toContain("Already resolved");
    expect(cardJson).not.toContain("Exec Approval: Denied");
    expect(cardJson).not.toContain("buttonList");
  });

  it("keeps the token retryable when the canonical card update fails", async () => {
    registerGoogleChatApprovalCardBinding({
      token: "token-update-retry",
      accountId: "default",
      approvalId: "approval-update-retry",
      approvalKind: "exec",
      decision: "allow-once",
      allowedDecisions: ["allow-once", "deny"],
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      expiresAtMs: Date.now() + 60_000,
    });
    resolveApprovalOverGateway
      .mockResolvedValueOnce(
        createApprovalResolveResult({
          applied: true,
          approvalId: "approval-update-retry",
          approvalKind: "exec",
          decision: "allow-once",
        }),
      )
      .mockResolvedValueOnce(
        createApprovalResolveResult({
          applied: false,
          approvalId: "approval-update-retry",
          approvalKind: "exec",
          decision: "allow-once",
        }),
      );
    updateGoogleChatMessage.mockRejectedValueOnce(new Error("card update failed"));

    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: createCardClickEvent("token-update-retry"),
        target: createTarget(),
      }),
    ).rejects.toThrow("card update failed");
    await expect(
      maybeHandleGoogleChatApprovalCardClick({
        event: createCardClickEvent("token-update-retry"),
        target: createTarget(),
      }),
    ).resolves.toBe(true);

    expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(2);
    expect(updateGoogleChatMessage).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(updateGoogleChatMessage.mock.calls[1]?.[0])).toContain(
      "Already resolved",
    );
  });
});
