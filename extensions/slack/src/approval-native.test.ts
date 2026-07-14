// Slack tests cover approval native plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it } from "vitest";
import { slackApprovalCapability } from "./approval-native.js";

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

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempStorePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-approval-native-"));
  tempDirs.push(dir);
  return path.join(dir, "sessions.json");
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
  return await slackApprovalCapability.native?.resolveOriginTarget?.({
    cfg: buildConfig(),
    accountId: "default",
    approvalKind: "exec",
    request: createExecApprovalRequest(requestOverrides),
  });
}

async function resolvePluginOriginTarget(sessionKey: string) {
  const storePath = createTempStorePath();
  return await slackApprovalCapability.native?.resolveOriginTarget?.({
    cfg: {
      ...buildConfig({ allowFrom: ["U123OWNER"] }),
      session: { store: storePath },
    },
    accountId: "default",
    approvalKind: "plugin",
    request: {
      id: "plugin:req-session",
      request: {
        title: "Plugin approval",
        description: "Allow access",
        sessionKey,
      },
      createdAtMs: 0,
      expiresAtMs: 1000,
    },
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
      slackApprovalCapability?.getActionAvailabilityState?.({
        cfg,
        accountId: "default",
        action: "approve",
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      slackApprovalCapability.native?.describeDeliveryCapabilities({
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
    const capabilities = slackApprovalCapability.native?.describeDeliveryCapabilities({
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

  it("does not reuse exec setup copy for plugin approval setup", () => {
    expect(
      slackApprovalCapability.describeExecApprovalSetup?.({
        channel: "slack",
        channelLabel: "Slack",
      }),
    ).toContain("`channels.slack.execApprovals.approvers`");
    expect(slackApprovalCapability.describePluginApprovalSetup).toBeUndefined();
  });

  it("resolves origin targets from slack turn source", async () => {
    const target = await resolveExecOriginTarget();

    expect(target).toEqual({
      to: "channel:C123",
      threadId: "1712345678.123456",
    });
  });

  it("resolves approver dm targets", async () => {
    const targets = await slackApprovalCapability.native?.resolveApproverDmTargets?.({
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

    const targets = await slackApprovalCapability.native?.resolveApproverDmTargets?.({
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
      slackApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }).enabled,
    ).toBe(true);
    expect(
      slackApprovalCapability.native?.describeDeliveryCapabilities({
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
      await slackApprovalCapability.native?.resolveApproverDmTargets?.({
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
        approvalKind: "plugin",
        request,
      }),
    ).toBe(true);
    expect(
      slackApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
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
    } as unknown as OpenClawConfig;
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
      slackApprovalCapability.native?.describeDeliveryCapabilities({
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
      slackApprovalCapability.native?.describeDeliveryCapabilities({
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
        approvalKind: "plugin",
        request,
      }),
    ).toBe(true);
  });

  it("delivers plugin forwarding session approvals to the Slack origin without concrete approvers", async () => {
    const cfg = {
      ...buildConfig({
        allowFrom: ["*"],
        execApprovals: {
          enabled: false,
          approvers: ["U999EXEC"],
          target: "dm",
        },
      }),
      approvals: {
        plugin: {
          enabled: true,
          mode: "session",
          sessionFilter: ["slack:"],
        },
      },
    } as unknown as OpenClawConfig;
    const request = {
      id: "plugin:req-open-session",
      request: {
        title: "Plugin approval",
        description: "Allow access",
        sessionKey: "slack:D123APPROVALS:test-run",
        turnSourceChannel: "slack",
        turnSourceTo: "channel:D123APPROVALS",
        turnSourceAccountId: "default",
      },
      createdAtMs: 0,
      expiresAtMs: 1_000,
    };

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
        approvalKind: "plugin",
        request,
      }),
    ).toBe(true);
    expect(
      slackApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }),
    ).toEqual({
      enabled: true,
      preferredSurface: "origin",
      supportsOriginSurface: true,
      supportsApproverDmSurface: false,
      notifyOriginWhenDmOnly: true,
    });
    expect(
      await slackApprovalCapability.native?.resolveOriginTarget?.({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }),
    ).toEqual({
      to: "channel:D123APPROVALS",
      threadId: undefined,
    });
  });

  it("requires Slack socket transport readiness before plugin forwarding enables native delivery", async () => {
    const cfg = {
      channels: {
        slack: {
          defaultAccount: "work",
          accounts: {
            work: {
              botToken: "xoxb-work",
              allowFrom: ["U123OWNER"],
              execApprovals: {
                enabled: false,
                target: "both",
              },
            },
          },
        },
      },
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", accountId: "work", to: "user:U123OWNER" }],
        },
      },
    } as unknown as OpenClawConfig;
    const request = {
      id: "plugin:req-transport",
      request: {
        title: "Plugin approval",
        description: "Allow access",
      },
      createdAtMs: 0,
      expiresAtMs: 1000,
    };

    expect(
      slackApprovalCapability.nativeRuntime?.availability.isConfigured({
        cfg,
        accountId: "work",
      }),
    ).toBe(false);
    expect(
      slackApprovalCapability.nativeRuntime?.availability.shouldHandle({
        cfg,
        accountId: "work",
        approvalKind: "plugin",
        request,
      }),
    ).toBe(false);
    expect(
      slackApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "work",
        approvalKind: "plugin",
        request,
      }).enabled,
    ).toBe(false);
  });

  it("treats HTTP signing secret configuration as Slack transport readiness", async () => {
    const cfg = {
      channels: {
        slack: {
          defaultAccount: "work",
          accounts: {
            work: {
              mode: "http",
              botToken: "xoxb-work",
              signingSecret: "signing-secret",
              allowFrom: ["U123OWNER"],
              execApprovals: {
                enabled: false,
                target: "both",
              },
            },
          },
        },
      },
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", accountId: "work", to: "user:U123OWNER" }],
        },
      },
    } as OpenClawConfig;
    const request = {
      id: "plugin:req-http",
      request: {
        title: "Plugin approval",
        description: "Allow access",
      },
      createdAtMs: 0,
      expiresAtMs: 1000,
    };

    expect(
      slackApprovalCapability.nativeRuntime?.availability.isConfigured({
        cfg,
        accountId: "work",
      }),
    ).toBe(true);
    expect(
      slackApprovalCapability.nativeRuntime?.availability.shouldHandle({
        cfg,
        accountId: "work",
        approvalKind: "plugin",
        request,
      }),
    ).toBe(true);
    expect(
      slackApprovalCapability.native?.describeDeliveryCapabilities({
        cfg,
        accountId: "work",
        approvalKind: "plugin",
        request,
      }).enabled,
    ).toBe(true);
  });

  it("treats HTTP signing secret SecretRefs as Slack transport readiness", async () => {
    const cfg = {
      channels: {
        slack: {
          defaultAccount: "work",
          accounts: {
            work: {
              mode: "http",
              botToken: "xoxb-work",
              signingSecret: {
                source: "env",
                id: "SLACK_SIGNING_SECRET",
              },
              allowFrom: ["U123OWNER"],
              execApprovals: {
                enabled: false,
                target: "both",
              },
            },
          },
        },
      },
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", accountId: "work", to: "user:U123OWNER" }],
        },
      },
    } as unknown as OpenClawConfig;
    const request = {
      id: "plugin:req-http-secret-ref",
      request: {
        title: "Plugin approval",
        description: "Allow access",
      },
      createdAtMs: 0,
      expiresAtMs: 1000,
    };

    expect(
      slackApprovalCapability.nativeRuntime?.availability.isConfigured({
        cfg,
        accountId: "work",
      }),
    ).toBe(true);
    expect(
      slackApprovalCapability.nativeRuntime?.availability.shouldHandle({
        cfg,
        accountId: "work",
        approvalKind: "plugin",
        request,
      }),
    ).toBe(true);
  });

  it("does not route plugin session fallback across Slack accounts", async () => {
    const storePath = createTempStorePath();
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:main:slack:channel:c999",
      entry: {
        sessionId: "sess",
        updatedAt: Date.now(),
        lastChannel: "slack",
        lastAccountId: "work",
      },
    });

    const cfg = {
      ...buildConfig({ allowFrom: ["U123OWNER"] }),
      session: { store: storePath },
      approvals: {
        plugin: {
          enabled: true,
          mode: "session",
        },
      },
    } as OpenClawConfig;
    const request = {
      id: "plugin:req-account-bound",
      request: {
        title: "Plugin approval",
        description: "Allow access",
        sessionKey: "agent:main:slack:channel:c999",
      },
      createdAtMs: 0,
      expiresAtMs: 1000,
    };

    expect(
      slackApprovalCapability.nativeRuntime?.availability.shouldHandle({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }),
    ).toBe(false);
    expect(
      await slackApprovalCapability.native?.resolveApproverDmTargets?.({
        cfg,
        accountId: "default",
        approvalKind: "plugin",
        request,
      }),
    ).toEqual([]);
    expect(
      slackApprovalCapability.nativeRuntime?.availability.shouldHandle({
        cfg,
        accountId: "work",
        approvalKind: "plugin",
        request,
      }),
    ).toBe(true);
  });

  it("resolves Slack app conversation plugin approvals to the live D-channel thread", async () => {
    const target = await slackApprovalCapability.native?.resolveOriginTarget?.({
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

  it("falls back to the session-key origin target for plugin approvals when the store is missing", async () => {
    const target = await resolvePluginOriginTarget(
      "agent:main:slack:channel:c08gqh53ejm:thread:1712345678.123456",
    );

    expect(target).toEqual({
      to: "channel:C08GQH53EJM",
      threadId: "1712345678.123456",
    });
  });

  it("preserves an enterprise-qualified session fallback instead of rewriting its segments", async () => {
    const target = await resolvePluginOriginTarget(
      "agent:main:slack:channel:team:T123:channel:C08GQH53EJM",
    );

    expect(target).toEqual({
      to: "channel:team:T123:channel:C08GQH53EJM",
      threadId: undefined,
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

    const originTarget = await slackApprovalCapability.native?.resolveOriginTarget?.({
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
    const dmTargets = await slackApprovalCapability.native?.resolveApproverDmTargets?.({
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
    const originTarget = await slackApprovalCapability.native?.resolveOriginTarget?.({
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
    const dmTargets = await slackApprovalCapability.native?.resolveApproverDmTargets?.({
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
    const shouldSuppress = slackApprovalCapability.delivery?.shouldSuppressForwardingFallback;
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
    const shouldSuppress = slackApprovalCapability.delivery?.shouldSuppressForwardingFallback;
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
    const shouldSuppress = slackApprovalCapability.delivery?.shouldSuppressForwardingFallback;
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
    const shouldSuppress = slackApprovalCapability.delivery?.shouldSuppressForwardingFallback;
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

  it("keeps plugin forwarding fallback when the native origin thread timestamp differs", () => {
    const shouldSuppress = slackApprovalCapability.delivery?.shouldSuppressForwardingFallback;
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
          threadId: "1712345678.1234567",
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
    ).toBe(false);
  });

  it("suppresses explicit plugin forwarding targets when native Slack plugin delivery is active", () => {
    const shouldSuppress = slackApprovalCapability.delivery?.shouldSuppressForwardingFallback;
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
    const shouldSuppress = slackApprovalCapability.delivery?.shouldSuppressForwardingFallback;
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
    const shouldSuppress = slackApprovalCapability.delivery?.shouldSuppressForwardingFallback;
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
      slackApprovalCapability.authorizeActorAction?.({
        cfg,
        accountId: "default",
        senderId: "U123OWNER",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });

    expect(
      slackApprovalCapability.authorizeActorAction?.({
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
      slackApprovalCapability.authorizeActorAction?.({
        cfg,
        accountId: "default",
        senderId: "U999EXEC",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });
});
