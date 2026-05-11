import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { clearSessionStoreCacheForTest } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it } from "vitest";
import { slackApprovalCapability, slackNativeApprovalAdapter } from "./approval-native.js";

function buildConfig(
  overrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>>,
): OpenClawConfig {
  return {
    channels: {
      slack: {
        botToken: "xoxb-test",
        appToken: "xapp-test",
        execApprovals: {
          enabled: true,
          approvers: ["U123APPROVER"],
          target: "both",
        },
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

const STORE_PATH = path.join(os.tmpdir(), "openclaw-slack-approval-native-test.json");

function writeStore(store: Record<string, unknown>) {
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  clearSessionStoreCacheForTest();
}

function createExecApprovalRequest(
  overrides: Partial<{
    turnSourceThreadId: string;
    sessionKey: string;
  }> = {},
) {
  return {
    id: "req-1",
    request: {
      command: "echo hi",
      turnSourceChannel: "slack",
      turnSourceTo: "channel:C123",
      turnSourceAccountId: "default",
      turnSourceThreadId: overrides.turnSourceThreadId ?? "1712345678.123456",
      sessionKey: overrides.sessionKey ?? "agent:main:slack:channel:c123:thread:1712345678.123456",
    },
    createdAtMs: 0,
    expiresAtMs: 1000,
  };
}

async function resolveExecOriginTarget(
  requestOverrides: Parameters<typeof createExecApprovalRequest>[0] = {},
) {
  return await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
    cfg: buildConfig(),
    accountId: "default",
    approvalKind: "exec",
    request: createExecApprovalRequest(requestOverrides),
  });
}

describe("slack native approval adapter", () => {
  it("keeps approval availability enabled when approvers exist but native delivery is off", () => {
    const cfg = buildConfig({
      execApprovals: {
        enabled: false,
        approvers: ["U123APPROVER"],
        target: "channel",
      },
    });

    expect(
      slackNativeApprovalAdapter.auth?.getActionAvailabilityState?.({
        cfg,
        accountId: "default",
        action: "approve",
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      slackNativeApprovalAdapter.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request: {
          id: "req-disabled-1",
          request: {
            command: "echo hi",
            turnSourceChannel: "slack",
            turnSourceTo: "channel:C123",
            turnSourceAccountId: "default",
            sessionKey: "agent:main:slack:channel:c123",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toEqual({
      enabled: false,
      preferredSurface: "origin",
      supportsOriginSurface: true,
      supportsApproverDmSurface: true,
      notifyOriginWhenDmOnly: true,
    });
  });

  it("describes native slack approval delivery capabilities", () => {
    const capabilities = slackNativeApprovalAdapter.native?.describeDeliveryCapabilities({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          turnSourceChannel: "slack",
          turnSourceTo: "channel:C123",
          turnSourceAccountId: "default",
          sessionKey: "agent:main:slack:channel:c123",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(capabilities).toEqual({
      enabled: true,
      preferredSurface: "both",
      supportsOriginSurface: true,
      supportsApproverDmSurface: true,
      notifyOriginWhenDmOnly: true,
    });
  });

  it("describes the correct Slack exec-approval setup path", () => {
    const text = slackApprovalCapability.describeExecApprovalSetup?.({
      channel: "slack",
      channelLabel: "Slack",
    });

    expect(text).toContain("`channels.slack.execApprovals.approvers`");
    expect(text).toContain("`commands.ownerAllowFrom`");
    expect(text).not.toContain("`channels.slack.dm.allowFrom`");
  });

  it("describes the named-account Slack exec-approval setup path", () => {
    const text = slackApprovalCapability.describeExecApprovalSetup?.({
      channel: "slack",
      channelLabel: "Slack",
      accountId: "work",
    });

    expect(text).toContain("`channels.slack.accounts.work.execApprovals.approvers`");
    expect(text).toContain("`commands.ownerAllowFrom`");
    expect(text).not.toContain("`channels.slack.execApprovals.approvers`");
  });

  it("resolves origin targets from slack turn source", async () => {
    const target = await resolveExecOriginTarget();

    expect(target).toEqual({
      to: "channel:C123",
      threadId: "1712345678.123456",
    });
  });

  it("keeps origin delivery when session and turn source thread ids differ only by Slack timestamp precision", async () => {
    const target = await resolveExecOriginTarget({
      turnSourceThreadId: "1712345678.1234567",
      sessionKey: "agent:main:slack:channel:c123:thread:1712345678.123456",
    });

    expect(target).toEqual({
      to: "channel:C123",
      threadId: "1712345678.1234567",
    });
  });

  it("resolves approver dm targets", async () => {
    const targets = await slackNativeApprovalAdapter.native?.resolveApproverDmTargets?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(targets).toEqual([{ to: "user:U123APPROVER" }]);
  });

  it("falls back to the session-bound origin target for plugin approvals", async () => {
    writeStore({
      "agent:main:slack:channel:c123": {
        sessionId: "sess",
        updatedAt: Date.now(),
        deliveryContext: {
          channel: "slack",
          to: "channel:C123",
          accountId: "default",
          threadId: "1712345678.123456",
        },
      },
    });

    const target = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      cfg: {
        ...buildConfig(),
        session: { store: STORE_PATH },
      },
      accountId: "default",
      approvalKind: "plugin",
      request: {
        id: "plugin:req-1",
        request: {
          title: "Plugin approval",
          description: "Allow access",
          sessionKey: "agent:main:slack:channel:c123",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "channel:C123",
      threadId: "1712345678.123456",
    });
  });

  it("falls back to the session-key origin target for plugin approvals when the store is missing", async () => {
    const target = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      cfg: {
        ...buildConfig(),
        session: { store: STORE_PATH },
      },
      accountId: "default",
      approvalKind: "plugin",
      request: {
        id: "plugin:req-1",
        request: {
          title: "Plugin approval",
          description: "Allow access",
          sessionKey: "agent:main:slack:channel:c123:thread:1712345678.123456",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "channel:C123",
      threadId: "1712345678.123456",
    });
  });

  it("skips native delivery when agent filters do not match", async () => {
    const cfg = buildConfig({
      execApprovals: {
        enabled: true,
        approvers: ["U123APPROVER"],
        target: "both",
        agentFilter: ["ops-agent"],
      },
    });

    const originTarget = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      cfg,
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          agentId: "other-agent",
          turnSourceChannel: "slack",
          turnSourceTo: "channel:C123",
          turnSourceAccountId: "default",
          sessionKey: "agent:other-agent:slack:channel:c123",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });
    const dmTargets = await slackNativeApprovalAdapter.native?.resolveApproverDmTargets?.({
      cfg,
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          agentId: "other-agent",
          sessionKey: "agent:other-agent:slack:channel:c123",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(originTarget).toBeNull();
    expect(dmTargets).toStrictEqual([]);
  });

  it("skips native delivery when the request is bound to another Slack account", async () => {
    const originTarget = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          turnSourceChannel: "slack",
          turnSourceTo: "channel:C123",
          turnSourceAccountId: "other",
          sessionKey: "agent:main:missing",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });
    const dmTargets = await slackNativeApprovalAdapter.native?.resolveApproverDmTargets?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          turnSourceChannel: "slack",
          turnSourceAccountId: "other",
          sessionKey: "agent:main:missing",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(originTarget).toBeNull();
    expect(dmTargets).toStrictEqual([]);
  });

  it("suppresses generic slack fallback only for slack-originated approvals", () => {
    const shouldSuppress = slackNativeApprovalAdapter.delivery?.shouldSuppressForwardingFallback;
    if (!shouldSuppress) {
      throw new Error("slack native delivery suppression unavailable");
    }

    expect(
      shouldSuppress({
        cfg: buildConfig(),
        approvalKind: "exec",
        target: { channel: "slack", to: "channel:C123ROOM", accountId: "default" },
        request: {
          id: "approval-1",
          request: {
            command: "echo hi",
            turnSourceChannel: "slack",
            turnSourceAccountId: "default",
          },
          createdAtMs: 0,
          expiresAtMs: 1_000,
        },
      }),
    ).toBe(true);

    expect(
      shouldSuppress({
        cfg: buildConfig(),
        approvalKind: "exec",
        target: { channel: "slack", to: "channel:C123ROOM", accountId: "default" },
        request: {
          id: "approval-1",
          request: {
            command: "echo hi",
            turnSourceChannel: "discord",
            turnSourceAccountId: "default",
          },
          createdAtMs: 0,
          expiresAtMs: 1_000,
        },
      }),
    ).toBe(false);
  });

  it("keeps plugin approval auth independent from exec approvers", () => {
    const cfg = buildConfig({
      allowFrom: ["U123OWNER"],
      execApprovals: {
        enabled: true,
        approvers: ["U999EXEC"],
        target: "both",
      },
    });

    expect(
      slackNativeApprovalAdapter.auth.authorizeActorAction?.({
        cfg,
        accountId: "default",
        senderId: "U123OWNER",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });

    expect(
      slackNativeApprovalAdapter.auth.authorizeActorAction?.({
        cfg,
        accountId: "default",
        senderId: "U999EXEC",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Slack.",
    });

    expect(
      slackNativeApprovalAdapter.auth.authorizeActorAction?.({
        cfg,
        accountId: "default",
        senderId: "U999EXEC",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });
});
