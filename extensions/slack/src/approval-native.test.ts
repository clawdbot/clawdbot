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
  it("subscribes the native runtime to exec and plugin approval events", () => {
    expect(slackApprovalCapability.nativeRuntime?.eventKinds).toEqual(["exec", "plugin"]);
  });

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

  it("rejects origin delivery when Slack thread ids differ in the fractional timestamp", async () => {
    writeStore({
      "agent:main:slack:channel:c123:thread:1712345678.123456": {
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

    const request = createExecApprovalRequest({
      turnSourceThreadId: "1712345678.1234567",
      sessionKey: "agent:main:slack:channel:c123:thread:1712345678.123456",
    });
    const target = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      cfg: { ...buildConfig(), session: { store: STORE_PATH } },
      accountId: "default",
      approvalKind: "exec",
      request,
    });

    expect(target).toBeNull();
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

  it("routes plugin approval dm targets to plugin approvers", async () => {
    const cfg = buildConfig({
      allowFrom: ["U123OWNER"],
      execApprovals: {
        enabled: true,
        approvers: ["U999EXEC"],
        target: "dm",
      },
    });

    const targets = await slackNativeApprovalAdapter.native?.resolveApproverDmTargets?.({
      cfg,
      accountId: "default",
      approvalKind: "plugin",
      request: {
        id: "plugin:req-1",
        request: {
          title: "Plugin approval",
          description: "Allow access",
          turnSourceChannel: "slack",
          turnSourceAccountId: "default",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(targets).toEqual([{ to: "user:U123OWNER" }]);
  });

  it("enables native plugin delivery from plugin approvers without exec approvers", async () => {
    const cfg = buildConfig({
      allowFrom: ["U123OWNER"],
      execApprovals: {
        enabled: true,
        target: "dm",
      },
    });
    const request = {
      id: "plugin:req-1",
      request: {
        title: "Plugin approval",
        description: "Allow access",
        turnSourceChannel: "slack",
        turnSourceAccountId: "default",
      },
      createdAtMs: 0,
      expiresAtMs: 1000,
    };

    expect(
      slackNativeApprovalAdapter.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }).enabled,
    ).toBe(true);
    expect(
      slackNativeApprovalAdapter.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request: {
          id: "req-1",
          request: {
            command: "echo hi",
            turnSourceChannel: "slack",
            turnSourceAccountId: "default",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }).enabled,
    ).toBe(false);
    expect(
      await slackNativeApprovalAdapter.native?.resolveApproverDmTargets?.({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }),
    ).toEqual([{ to: "user:U123OWNER" }]);
    expect(
      slackApprovalCapability.nativeRuntime?.availability.isConfigured({
        cfg,
        accountId: "default",
      }),
    ).toBe(true);
    expect(
      slackApprovalCapability.nativeRuntime?.availability.shouldHandle({
        cfg,
        accountId: "default",
        request,
      }),
    ).toBe(true);
    expect(
      slackNativeApprovalAdapter.delivery?.shouldSuppressForwardingFallback?.({
        cfg,
        approvalKind: "plugin",
        target: { channel: "slack", to: "user:U123OWNER", accountId: "default" },
        request,
      }),
    ).toBe(true);
  });

  it("enables native plugin delivery from plugin forwarding when exec native delivery is disabled", async () => {
    const cfg = {
      ...buildConfig({
        allowFrom: ["U123OWNER"],
        execApprovals: {
          enabled: false,
          approvers: ["U999EXEC"],
          target: "both",
        },
      }),
      approvals: {
        plugin: {
          enabled: true,
          mode: "both",
          agentFilter: ["dev"],
          targets: [{ channel: "slack", to: "U123OWNER" }],
        },
      },
    } as OpenClawConfig;
    const request = {
      id: "plugin:req-1",
      request: {
        title: "Plugin approval",
        description: "Allow access",
        agentId: "dev",
      },
      createdAtMs: 0,
      expiresAtMs: 1000,
    };

    expect(
      slackNativeApprovalAdapter.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request: {
          id: "req-1",
          request: {
            command: "echo hi",
            turnSourceChannel: "slack",
            turnSourceAccountId: "default",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }).enabled,
    ).toBe(false);
    expect(
      slackNativeApprovalAdapter.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }).enabled,
    ).toBe(true);
    expect(
      slackApprovalCapability.nativeRuntime?.availability.isConfigured({
        cfg,
        accountId: "default",
      }),
    ).toBe(true);
    expect(
      slackApprovalCapability.nativeRuntime?.availability.shouldHandle({
        cfg,
        accountId: "default",
        request,
      }),
    ).toBe(true);
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
        ...buildConfig({ allowFrom: ["U123OWNER"] }),
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

  it("resolves Slack app conversation plugin approvals to the live D-channel thread", async () => {
    const target = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      cfg: buildConfig({ allowFrom: ["U123OWNER"] }),
      accountId: "default",
      approvalKind: "plugin",
      request: {
        id: "plugin:req-1",
        request: {
          title: "Plugin approval",
          description: "Allow access",
          sessionKey: "agent:main:slack:direct:u123owner:thread:1712345678.123456",
          turnSourceChannel: "slack",
          turnSourceTo: "D0ACP6B1T8V",
          turnSourceAccountId: "default",
          turnSourceThreadId: "1712345678.123456",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "channel:D0ACP6B1T8V",
      threadId: "1712345678.123456",
    });
  });

  it("prefers Slack app conversation D-channel turn source over user-scoped session route", async () => {
    writeStore({
      "agent:main:slack:direct:u123owner:thread:1712345678.123456": {
        sessionId: "sess",
        updatedAt: Date.now(),
        deliveryContext: {
          channel: "slack",
          to: "user:U123OWNER",
          accountId: "default",
          threadId: "1712345678.123456",
        },
      },
    });

    const target = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      cfg: {
        ...buildConfig({ allowFrom: ["U123OWNER"] }),
        session: { store: STORE_PATH },
      },
      accountId: "default",
      approvalKind: "plugin",
      request: {
        id: "plugin:req-1",
        request: {
          title: "Plugin approval",
          description: "Allow access",
          sessionKey: "agent:main:slack:direct:u123owner:thread:1712345678.123456",
          turnSourceChannel: "slack",
          turnSourceTo: "D0ACP6B1T8V",
          turnSourceAccountId: "default",
          turnSourceThreadId: "1712345678.123456",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "channel:D0ACP6B1T8V",
      threadId: "1712345678.123456",
    });
  });

  it("does not treat Slack D-channel and user route targets as matching across threads", async () => {
    writeStore({
      "agent:main:slack:direct:u123owner:thread:1712345678.123456": {
        sessionId: "sess",
        updatedAt: Date.now(),
        deliveryContext: {
          channel: "slack",
          to: "user:U123OWNER",
          accountId: "default",
          threadId: "1712345678.123456",
        },
      },
    });

    const target = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      cfg: {
        ...buildConfig({ allowFrom: ["U123OWNER"] }),
        session: { store: STORE_PATH },
      },
      accountId: "default",
      approvalKind: "plugin",
      request: {
        id: "plugin:req-1",
        request: {
          title: "Plugin approval",
          description: "Allow access",
          sessionKey: "agent:main:slack:direct:u123owner:thread:1712345678.123456",
          turnSourceChannel: "slack",
          turnSourceTo: "D0ACP6B1T8V",
          turnSourceAccountId: "default",
          turnSourceThreadId: "1712349999.123456",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toBeNull();
  });

  it("does not treat same-second Slack D-channel and user route targets as the same thread", async () => {
    writeStore({
      "agent:main:slack:direct:u123owner:thread:1712345678.123456": {
        sessionId: "sess",
        updatedAt: Date.now(),
        deliveryContext: {
          channel: "slack",
          to: "user:U123OWNER",
          accountId: "default",
          threadId: "1712345678.123456",
        },
      },
    });

    const target = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      cfg: {
        ...buildConfig({ allowFrom: ["U123OWNER"] }),
        session: { store: STORE_PATH },
      },
      accountId: "default",
      approvalKind: "plugin",
      request: {
        id: "plugin:req-1",
        request: {
          title: "Plugin approval",
          description: "Allow access",
          sessionKey: "agent:main:slack:direct:u123owner:thread:1712345678.123456",
          turnSourceChannel: "slack",
          turnSourceTo: "D0ACP6B1T8V",
          turnSourceAccountId: "default",
          turnSourceThreadId: "1712345678.999999",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toBeNull();
  });

  it("does not treat same-second Slack channel route targets as the same thread", async () => {
    writeStore({
      "agent:main:slack:channel:c123room:thread:1712345678.123456": {
        sessionId: "sess",
        updatedAt: Date.now(),
        deliveryContext: {
          channel: "slack",
          to: "channel:C123ROOM",
          accountId: "default",
          threadId: "1712345678.123456",
        },
      },
    });

    const target = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      cfg: {
        ...buildConfig({ allowFrom: ["U123OWNER"] }),
        session: { store: STORE_PATH },
      },
      accountId: "default",
      approvalKind: "plugin",
      request: {
        id: "plugin:req-1",
        request: {
          title: "Plugin approval",
          description: "Allow access",
          sessionKey: "agent:main:slack:channel:c123room:thread:1712345678.123456",
          turnSourceChannel: "slack",
          turnSourceTo: "channel:C123ROOM",
          turnSourceAccountId: "default",
          turnSourceThreadId: "1712345678.999999",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toBeNull();
  });

  it("falls back to the session-key origin target for plugin approvals when the store is missing", async () => {
    const target = await slackNativeApprovalAdapter.native?.resolveOriginTarget?.({
      cfg: {
        ...buildConfig({ allowFrom: ["U123OWNER"] }),
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

  it("keeps plugin forwarding fallback when Slack has no plugin approvers", () => {
    const shouldSuppress = slackNativeApprovalAdapter.delivery?.shouldSuppressForwardingFallback;
    if (!shouldSuppress) {
      throw new Error("slack native delivery suppression unavailable");
    }

    expect(
      shouldSuppress({
        cfg: buildConfig({
          execApprovals: {
            enabled: true,
            approvers: ["U999EXEC"],
            target: "dm",
          },
        }),
        approvalKind: "plugin",
        target: { channel: "slack", to: "channel:C123ROOM", accountId: "default" },
        request: {
          id: "plugin:approval-1",
          request: {
            title: "Plugin approval",
            description: "Allow access",
            turnSourceChannel: "slack",
            turnSourceAccountId: "default",
          },
          createdAtMs: 0,
          expiresAtMs: 1_000,
        },
      }),
    ).toBe(false);
  });

  it("keeps plugin forwarding fallback for Slack targets not handled by native delivery", () => {
    const shouldSuppress = slackNativeApprovalAdapter.delivery?.shouldSuppressForwardingFallback;
    if (!shouldSuppress) {
      throw new Error("slack native delivery suppression unavailable");
    }

    expect(
      shouldSuppress({
        cfg: buildConfig({
          allowFrom: ["U123OWNER"],
          execApprovals: {
            enabled: true,
            approvers: ["U999EXEC"],
            target: "dm",
          },
        }),
        approvalKind: "plugin",
        target: { channel: "slack", to: "channel:CAPPROVALS", accountId: "default" },
        request: {
          id: "plugin:approval-1",
          request: {
            title: "Plugin approval",
            description: "Allow access",
            turnSourceChannel: "slack",
            turnSourceAccountId: "default",
          },
          createdAtMs: 0,
          expiresAtMs: 1_000,
        },
      }),
    ).toBe(false);
  });

  it("suppresses plugin forwarding fallback for the native origin target", () => {
    const shouldSuppress = slackNativeApprovalAdapter.delivery?.shouldSuppressForwardingFallback;
    if (!shouldSuppress) {
      throw new Error("slack native delivery suppression unavailable");
    }

    expect(
      shouldSuppress({
        cfg: buildConfig({
          allowFrom: ["U123OWNER"],
          execApprovals: {
            enabled: true,
            approvers: ["U999EXEC"],
            target: "dm",
          },
        }),
        approvalKind: "plugin",
        target: {
          channel: "slack",
          to: "channel:C123ROOM",
          accountId: "default",
          threadId: "1712345678.123456",
        },
        request: {
          id: "plugin:approval-1",
          request: {
            title: "Plugin approval",
            description: "Allow access",
            turnSourceChannel: "slack",
            turnSourceTo: "channel:C123ROOM",
            turnSourceAccountId: "default",
            turnSourceThreadId: "1712345678.123456",
          },
          createdAtMs: 0,
          expiresAtMs: 1_000,
        },
      }),
    ).toBe(true);
  });

  it("suppresses plugin forwarding fallback for the persisted native origin target", () => {
    const shouldSuppress = slackNativeApprovalAdapter.delivery?.shouldSuppressForwardingFallback;
    if (!shouldSuppress) {
      throw new Error("slack native delivery suppression unavailable");
    }

    writeStore({
      "agent:main:main": {
        sessionId: "sess",
        updatedAt: Date.now(),
        deliveryContext: {
          channel: "slack",
          to: "channel:CSTORED",
          accountId: "default",
          threadId: "1712345678.123456",
        },
      },
    });

    expect(
      shouldSuppress({
        cfg: {
          ...buildConfig({ allowFrom: ["U123OWNER"] }),
          session: { store: STORE_PATH },
        },
        approvalKind: "plugin",
        target: {
          channel: "slack",
          to: "channel:CSTORED",
          accountId: "default",
          threadId: "1712345678.123456",
        },
        request: {
          id: "plugin:approval-1",
          request: {
            title: "Plugin approval",
            description: "Allow access",
            sessionKey: "agent:main:main",
          },
          createdAtMs: 0,
          expiresAtMs: 1_000,
        },
      }),
    ).toBe(true);
  });

  it("suppresses explicit plugin forwarding targets when native Slack plugin delivery is active", () => {
    const shouldSuppress = slackNativeApprovalAdapter.delivery?.shouldSuppressForwardingFallback;
    if (!shouldSuppress) {
      throw new Error("slack native delivery suppression unavailable");
    }

    const cfg = {
      ...buildConfig({
        allowFrom: ["U123OWNER"],
        execApprovals: {
          enabled: false,
          approvers: ["U999EXEC"],
          target: "both",
        },
      }),
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", to: "user:U123OWNER" }],
        },
      },
    } as OpenClawConfig;

    expect(
      shouldSuppress({
        cfg,
        approvalKind: "plugin",
        target: { channel: "slack", to: "user:U123OWNER", accountId: "default" },
        request: {
          id: "plugin:approval-1",
          request: {
            title: "Plugin approval",
            description: "Allow access",
          },
          createdAtMs: 0,
          expiresAtMs: 1_000,
        },
      }),
    ).toBe(true);
  });

  it("suppresses bare Slack user plugin forwarding targets handled by native DM delivery", () => {
    const shouldSuppress = slackNativeApprovalAdapter.delivery?.shouldSuppressForwardingFallback;
    if (!shouldSuppress) {
      throw new Error("slack native delivery suppression unavailable");
    }

    const cfg = {
      ...buildConfig({
        allowFrom: ["U123OWNER"],
        execApprovals: {
          enabled: false,
          approvers: ["U999EXEC"],
          target: "both",
        },
      }),
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", to: "U123OWNER" }],
        },
      },
    } as OpenClawConfig;

    expect(
      shouldSuppress({
        cfg,
        approvalKind: "plugin",
        target: { channel: "slack", to: "U123OWNER", accountId: "default" },
        request: {
          id: "plugin:approval-1",
          request: {
            title: "Plugin approval",
            description: "Allow access",
            turnSourceChannel: "slack",
            turnSourceTo: "user:U123OWNER",
            turnSourceAccountId: "default",
            sessionKey: "agent:main:slack:direct:U123OWNER",
          },
          createdAtMs: 0,
          expiresAtMs: 1_000,
        },
      }),
    ).toBe(true);
  });

  it("keeps explicit plugin forwarding channel targets outside native Slack delivery", () => {
    const shouldSuppress = slackNativeApprovalAdapter.delivery?.shouldSuppressForwardingFallback;
    if (!shouldSuppress) {
      throw new Error("slack native delivery suppression unavailable");
    }

    const cfg = {
      ...buildConfig({
        allowFrom: ["U123OWNER"],
        execApprovals: {
          enabled: false,
          approvers: ["U999EXEC"],
          target: "both",
        },
      }),
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", to: "channel:CAPPROVALS" }],
        },
      },
    } as OpenClawConfig;

    expect(
      shouldSuppress({
        cfg,
        approvalKind: "plugin",
        target: { channel: "slack", to: "channel:CAPPROVALS", accountId: "default" },
        request: {
          id: "plugin:approval-1",
          request: {
            title: "Plugin approval",
            description: "Allow access",
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
