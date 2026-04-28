import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it } from "vitest";
import { matrixApprovalCapability } from "./approval-native.js";

function buildConfig(
  overrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["matrix"]>>,
): OpenClawConfig {
  return {
    channels: {
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok",
        execApprovals: {
          enabled: true,
          approvers: ["@owner:example.org"],
          target: "both",
        },
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

describe("matrix approval capability", () => {
  it("describes the correct Matrix exec-approval setup path", () => {
    const text = matrixApprovalCapability.describeExecApprovalSetup?.({
      channel: "matrix",
      channelLabel: "Matrix",
    });

    expect(text).toContain("`channels.matrix.execApprovals.approvers`");
    expect(text).toContain("`channels.matrix.dm.allowFrom`");
  });

  it("describes the named-account Matrix exec-approval setup path", () => {
    const text = matrixApprovalCapability.describeExecApprovalSetup?.({
      channel: "matrix",
      channelLabel: "Matrix",
      accountId: "work",
    });

    expect(text).toContain("`channels.matrix.accounts.work.execApprovals.approvers`");
    expect(text).toContain("`channels.matrix.accounts.work.dm.allowFrom`");
    expect(text).not.toContain("`channels.matrix.execApprovals.approvers`");
  });

  it("describes native matrix approval delivery capabilities", () => {
    const capabilities = matrixApprovalCapability.native?.describeDeliveryCapabilities({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          turnSourceChannel: "matrix",
          turnSourceTo: "room:!ops:example.org",
          turnSourceAccountId: "default",
          sessionKey: "agent:main:matrix:channel:!ops:example.org",
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

  it("resolves origin targets from matrix turn source", async () => {
    const target = await matrixApprovalCapability.native?.resolveOriginTarget?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          turnSourceChannel: "matrix",
          turnSourceTo: "room:!ops:example.org",
          turnSourceThreadId: "$thread",
          turnSourceAccountId: "default",
          sessionKey: "agent:main:matrix:channel:!ops:example.org",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "room:!ops:example.org",
      threadId: "$thread",
    });
  });

  it("resolves approver dm targets", async () => {
    const targets = await matrixApprovalCapability.native?.resolveApproverDmTargets?.({
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

    expect(targets).toEqual([{ to: "user:@owner:example.org" }]);
  });

  it("suppresses same-channel plugin forwarding when Matrix native delivery is available", () => {
    const shouldSuppress = matrixApprovalCapability.delivery?.shouldSuppressForwardingFallback;
    if (!shouldSuppress) {
      throw new Error("delivery suppression helper unavailable");
    }

    expect(
      shouldSuppress({
        cfg: buildConfig({
          dm: { allowFrom: ["@owner:example.org"] },
        }),
        approvalKind: "plugin",
        target: {
          channel: "matrix",
          to: "room:!ops:example.org",
          accountId: "default",
        },
        request: {
          id: "plugin:req-1",
          request: {
            title: "Plugin Approval Required",
            description: "Allow plugin action",
            pluginId: "git-tools",
            turnSourceChannel: "matrix",
            turnSourceTo: "room:!ops:example.org",
            turnSourceAccountId: "default",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      } as never),
    ).toBe(true);
  });

  it("preserves room-id case when matching Matrix origin targets", async () => {
    const target = await matrixApprovalCapability.native?.resolveOriginTarget?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          turnSourceChannel: "matrix",
          turnSourceTo: "room:!Ops:Example.org",
          turnSourceThreadId: "$thread",
          turnSourceAccountId: "default",
          sessionKey: "agent:main:matrix:channel:!Ops:Example.org",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "room:!Ops:Example.org",
      threadId: "$thread",
    });
  });

  it("keeps plugin approval auth independent from exec approvers", () => {
    const cfg = buildConfig({
      dm: { allowFrom: ["@owner:example.org"] },
      execApprovals: {
        enabled: true,
        approvers: ["@exec:example.org"],
        target: "both",
      },
    });

    expect(
      matrixApprovalCapability.authorizeActorAction?.({
        cfg,
        accountId: "default",
        senderId: "@owner:example.org",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });

    expect(
      matrixApprovalCapability.authorizeActorAction?.({
        cfg,
        accountId: "default",
        senderId: "@exec:example.org",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Matrix.",
    });

    expect(
      matrixApprovalCapability.authorizeActorAction?.({
        cfg,
        accountId: "default",
        senderId: "@exec:example.org",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });

  it("requires Matrix DM approvers before enabling plugin approval auth", () => {
    const cfg = buildConfig({
      dm: { allowFrom: [] },
      execApprovals: {
        enabled: true,
        approvers: ["@exec:example.org"],
        target: "both",
      },
    });

    expect(
      matrixApprovalCapability.authorizeActorAction?.({
        cfg,
        accountId: "default",
        senderId: "@exec:example.org",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ Matrix plugin approvals are not enabled for this bot account.",
    });
  });

  it("reports exec initiating-surface availability independently from plugin auth", () => {
    const cfg = buildConfig({
      dm: { allowFrom: ["@owner:example.org"] },
      execApprovals: {
        enabled: false,
        approvers: [],
        target: "both",
      },
    });

    expect(
      matrixApprovalCapability.getActionAvailabilityState?.({
        cfg,
        accountId: "default",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ kind: "enabled" });

    expect(
      matrixApprovalCapability.getExecInitiatingSurfaceState?.({
        cfg,
        accountId: "default",
        action: "approve",
      }),
    ).toEqual({ kind: "disabled" });
  });

  it("enables matrix-native plugin approval delivery when DM approvers are configured", () => {
    const capabilities = matrixApprovalCapability.native?.describeDeliveryCapabilities({
      cfg: buildConfig({
        dm: { allowFrom: ["@owner:example.org"] },
      }),
      accountId: "default",
      approvalKind: "plugin",
      request: {
        id: "plugin:req-1",
        request: {
          title: "Plugin Approval Required",
          description: "Allow plugin access",
          pluginId: "git-tools",
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

  it("keeps matrix-native plugin approval delivery disabled without DM approvers", () => {
    const capabilities = matrixApprovalCapability.native?.describeDeliveryCapabilities({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "plugin",
      request: {
        id: "plugin:req-1",
        request: {
          title: "Plugin Approval Required",
          description: "Allow plugin access",
          pluginId: "git-tools",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(capabilities).toEqual({
      enabled: false,
      preferredSurface: "both",
      supportsOriginSurface: true,
      supportsApproverDmSurface: true,
      notifyOriginWhenDmOnly: true,
    });
  });
});
