import { isImplicitSameChatApprovalAuthorization } from "openclaw/plugin-sdk/approval-auth-runtime";
import type { ExecApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelOutboundPayloadHint } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it } from "vitest";
import {
  isMSTeamsNativeApprovalClientEnabled,
  msTeamsApprovalCapability,
  shouldHandleMSTeamsNativeApprovalRequest,
  shouldSuppressLocalMSTeamsExecApprovalPrompt,
} from "./approval-native.js";

const APPROVER_ID = "40a1a0ed-4ff2-4164-a219-55518990c197";
const OTHER_USER_ID = "b2d381f1-36dd-4120-b6fb-8dd37388ff11";
const CONVERSATION_ID = "19:channel@thread.tacv2";

function createConfig(
  overrides: {
    approvals?: OpenClawConfig["approvals"];
    teams?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["msteams"]>>;
  } = {},
): OpenClawConfig {
  return {
    approvals: overrides.approvals ?? { exec: { enabled: true } },
    channels: {
      msteams: {
        appId: "app-id",
        appPassword: "app-password",
        tenantId: "tenant-id",
        allowFrom: [APPROVER_ID],
        ...overrides.teams,
      },
    },
  };
}

function createExecRequest(
  overrides: Partial<ExecApprovalRequest["request"]> = {},
): ExecApprovalRequest {
  return {
    id: "approval-1",
    request: {
      command: "echo hello",
      turnSourceChannel: "msteams",
      turnSourceTo: `conversation:${CONVERSATION_ID}`,
      turnSourceAccountId: "default",
      ...overrides,
    },
    createdAtMs: 0,
    expiresAtMs: 60_000,
  };
}

const pendingExecPayload: ReplyPayload = {
  text: "Approval required.",
  channelData: {
    execApproval: {
      approvalId: "12345678-1234-1234-1234-123456789012",
      approvalSlug: "12345678",
      approvalKind: "exec",
      agentId: "main",
      sessionKey: "agent:main:msteams:channel:example",
    },
  },
};

const activeExecApprovalHint: ChannelOutboundPayloadHint = {
  kind: "approval-pending",
  approvalKind: "exec",
  nativeRouteActive: true,
};

describe("Microsoft Teams native approval capability", () => {
  it("subscribes to exec and plugin approvals for a configured bot and approver", () => {
    const runtime = msTeamsApprovalCapability.nativeRuntime;

    expect(runtime?.eventKinds).toEqual(["exec", "plugin"]);
    expect(runtime?.availability.isConfigured({ cfg: createConfig() })).toBe(true);
    expect(
      runtime?.availability.isConfigured({
        cfg: createConfig({ approvals: { plugin: { enabled: true } } }),
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: "approval forwarding is absent",
      cfg: { channels: createConfig().channels } satisfies OpenClawConfig,
    },
    {
      name: "exec forwarding is disabled",
      cfg: createConfig({ approvals: { exec: { enabled: false } } }),
    },
    {
      name: "forwarding only targets another channel",
      cfg: createConfig({
        approvals: {
          exec: {
            enabled: true,
            mode: "targets",
            targets: [{ channel: "slack", to: "channel:C123" }],
          },
        },
      }),
    },
    {
      name: "the Teams account is disabled",
      cfg: createConfig({ teams: { enabled: false } }),
    },
    {
      name: "the bot credentials are incomplete",
      cfg: createConfig({ teams: { appPassword: undefined } }),
    },
    {
      name: "no approvers are configured",
      cfg: createConfig({ teams: { allowFrom: undefined } }),
    },
    {
      name: "allowlist entries are not stable Entra object IDs",
      cfg: createConfig({ teams: { allowFrom: ["someone@example.com", "*"] } }),
    },
  ])("does not enable native approvals when $name", ({ cfg }) => {
    expect(isMSTeamsNativeApprovalClientEnabled({ cfg })).toBe(false);
  });

  it("accepts a valid default destination as the configured approver", () => {
    const cfg = createConfig({
      teams: { allowFrom: undefined, defaultTo: `user:${APPROVER_ID.toUpperCase()}` },
    });

    expect(isMSTeamsNativeApprovalClientEnabled({ cfg })).toBe(true);
    expect(
      msTeamsApprovalCapability.authorizeActorAction?.({
        cfg,
        senderId: APPROVER_ID,
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });

  it("keeps authorization available when native forwarding is disabled", () => {
    const cfg = createConfig({ approvals: { exec: { enabled: false } } });

    expect(
      msTeamsApprovalCapability.getActionAvailabilityState?.({
        cfg,
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      msTeamsApprovalCapability.authorizeActorAction?.({
        cfg,
        senderId: APPROVER_ID.toUpperCase(),
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });

  it("rejects unlisted actors for both approval kinds", () => {
    for (const approvalKind of ["exec", "plugin"] as const) {
      expect(
        msTeamsApprovalCapability.authorizeActorAction?.({
          cfg: createConfig(),
          senderId: OTHER_USER_ID,
          action: "approve",
          approvalKind,
        }),
      ).toEqual({
        authorized: false,
        reason: `❌ You are not authorized to approve ${approvalKind} requests on Microsoft Teams.`,
      });
    }
  });

  it("preserves implicit same-chat authorization when no approvers are configured", () => {
    const authorization = msTeamsApprovalCapability.authorizeActorAction?.({
      cfg: createConfig({ teams: { allowFrom: undefined } }),
      senderId: OTHER_USER_ID,
      action: "approve",
      approvalKind: "exec",
    });

    expect(authorization).toEqual({ authorized: true });
    expect(isImplicitSameChatApprovalAuthorization(authorization)).toBe(true);
  });

  it("restricts routing to the single Teams account and originating channel", () => {
    const cfg = createConfig();
    const request = createExecRequest();

    expect(
      shouldHandleMSTeamsNativeApprovalRequest({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toBe(true);
    expect(
      shouldHandleMSTeamsNativeApprovalRequest({
        cfg,
        accountId: "other",
        approvalKind: "exec",
        request,
      }),
    ).toBe(false);
    expect(
      shouldHandleMSTeamsNativeApprovalRequest({
        cfg,
        approvalKind: "exec",
        request: createExecRequest({ turnSourceChannel: "slack" }),
      }),
    ).toBe(false);
    expect(
      shouldHandleMSTeamsNativeApprovalRequest({
        cfg,
        approvalKind: "exec",
        request: createExecRequest({ turnSourceTo: "  " }),
      }),
    ).toBe(false);
  });

  it("does not handle exec approvals when only plugin forwarding is enabled", () => {
    expect(
      shouldHandleMSTeamsNativeApprovalRequest({
        cfg: createConfig({ approvals: { plugin: { enabled: true } } }),
        approvalKind: "exec",
        request: createExecRequest(),
      }),
    ).toBe(false);
  });

  it("preserves the normalized conversation and source thread for native delivery", () => {
    const request = createExecRequest({
      turnSourceTo: `teams:conversation:${CONVERSATION_ID}`,
      turnSourceThreadId: "thread-root-123",
    });

    expect(
      msTeamsApprovalCapability.native?.resolveOriginTarget?.({
        cfg: createConfig(),
        accountId: "default",
        approvalKind: "exec",
        request,
      }),
    ).toEqual({
      to: `conversation:${CONVERSATION_ID}`,
      accountId: "default",
      threadId: "thread-root-123",
    });
  });

  it("maps stable allowlisted approvers to user-prefixed Teams DM targets", () => {
    expect(
      msTeamsApprovalCapability.native?.resolveApproverDmTargets?.({
        cfg: createConfig(),
        accountId: "default",
        approvalKind: "exec",
        request: createExecRequest(),
      }),
    ).toEqual([{ to: `user:${APPROVER_ID}`, accountId: "default" }]);
  });

  it("suppresses the duplicate text prompt only while native exec delivery owns it", () => {
    expect(
      shouldSuppressLocalMSTeamsExecApprovalPrompt({
        cfg: createConfig(),
        payload: pendingExecPayload,
        hint: activeExecApprovalHint,
      }),
    ).toBe(true);

    expect(
      shouldSuppressLocalMSTeamsExecApprovalPrompt({
        cfg: createConfig(),
        payload: pendingExecPayload,
        hint: { ...activeExecApprovalHint, nativeRouteActive: false },
      }),
    ).toBe(false);

    expect(
      shouldSuppressLocalMSTeamsExecApprovalPrompt({
        cfg: createConfig({ approvals: { exec: { enabled: false } } }),
        payload: pendingExecPayload,
        hint: activeExecApprovalHint,
      }),
    ).toBe(false);
  });

  it("describes the existing Teams allowlist and default destination setup", () => {
    const guidance = msTeamsApprovalCapability.describeExecApprovalSetup?.({
      channel: "msteams",
      channelLabel: "Microsoft Teams",
    });

    expect(guidance).toContain("`channels.msteams.allowFrom`");
    expect(guidance).toContain("`channels.msteams.defaultTo`");
  });
});
