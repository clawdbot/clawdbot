import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clearSessionStoreCacheForTest } from "../../../src/config/sessions/store.js";
import {
  createDiscordNativeApprovalAdapter,
  getDiscordApprovalCapability,
  shouldHandleDiscordApprovalRequest,
} from "./approval-native.js";

const STORE_PATH = path.join(os.tmpdir(), "openclaw-discord-approval-native-test.json");
const NATIVE_APPROVAL_CFG = {
  commands: {
    ownerAllowFrom: ["discord:555555555"],
  },
} as const;
const NATIVE_DELIVERY_CFG = {
  ...NATIVE_APPROVAL_CFG,
  channels: {
    discord: {
      execApprovals: {
        enabled: true,
      },
    },
  },
} as const;

function writeStore(store: Record<string, unknown>) {
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  clearSessionStoreCacheForTest();
}

describe("createDiscordNativeApprovalAdapter", () => {
  it("keeps approval availability enabled when approvers exist but native delivery is off", () => {
    const adapter = createDiscordNativeApprovalAdapter({
      enabled: false,
      approvers: ["555555555"],
      target: "channel",
    } as never);

    expect(
      adapter.auth?.getActionAvailabilityState?.({
        cfg: NATIVE_APPROVAL_CFG as never,
        accountId: "main",
        action: "approve",
      }),
    ).toEqual({ kind: "enabled" });
    expect(
      adapter.native?.describeDeliveryCapabilities({
        cfg: NATIVE_APPROVAL_CFG as never,
        accountId: "main",
        approvalKind: "exec",
        request: {
          id: "approval-1",
          request: {
            command: "pwd",
            turnSourceChannel: "discord",
            turnSourceTo: "channel:123456789",
            turnSourceAccountId: "main",
            sessionKey: "agent:main:discord:channel:123456789",
          },
          createdAtMs: 1,
          expiresAtMs: 2,
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

  it("honors ownerAllowFrom fallback when gating approval requests", () => {
    expect(
      shouldHandleDiscordApprovalRequest({
        cfg: {
          commands: {
            ownerAllowFrom: ["discord:123"],
          },
        } as never,
        accountId: "main",
        configOverride: { enabled: true } as never,
        request: {
          id: "approval-1",
          request: {
            command: "pwd",
            turnSourceChannel: "discord",
            turnSourceTo: "channel:123456789",
            turnSourceAccountId: "main",
          },
          createdAtMs: 1,
          expiresAtMs: 2,
        },
      }),
    ).toBe(true);
  });

  it("describes the correct Discord exec-approval setup path", () => {
    const text = getDiscordApprovalCapability().describeExecApprovalSetup?.({
      channel: "discord",
      channelLabel: "Discord",
    });

    expect(text).toContain("`channels.discord.execApprovals.approvers`");
    expect(text).toContain("`commands.ownerAllowFrom`");
    expect(text).not.toContain("`channels.discord.dm.allowFrom`");
  });

  it("describes the named-account Discord exec-approval setup path", () => {
    const text = getDiscordApprovalCapability().describeExecApprovalSetup?.({
      channel: "discord",
      channelLabel: "Discord",
      accountId: "work",
    });

    expect(text).toContain("`channels.discord.accounts.work.execApprovals.approvers`");
    expect(text).toContain("`commands.ownerAllowFrom`");
    expect(text).not.toContain("`channels.discord.execApprovals.approvers`");
  });

  it("normalizes prefixed turn-source channel ids", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      cfg: NATIVE_DELIVERY_CFG as never,
      accountId: "main",
      approvalKind: "plugin",
      request: {
        id: "abc",
        request: {
          title: "Plugin approval",
          description: "Let plugin proceed",
          turnSourceChannel: "discord",
          turnSourceTo: "channel:123456789",
          turnSourceAccountId: "main",
        },
        createdAtMs: 1,
        expiresAtMs: 2,
      },
    });

    expect(target).toEqual({ to: "123456789" });
  });

  it("falls back to approver DMs for Discord DM sessions with raw turn-source ids", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      cfg: NATIVE_DELIVERY_CFG as never,
      accountId: "main",
      approvalKind: "plugin",
      request: {
        id: "abc",
        request: {
          title: "Plugin approval",
          description: "Let plugin proceed",
          sessionKey: "agent:main:discord:dm:123456789",
          turnSourceChannel: "discord",
          turnSourceTo: "123456789",
          turnSourceAccountId: "main",
        },
        createdAtMs: 1,
        expiresAtMs: 2,
      },
    });

    expect(target).toBeNull();
  });

  it("ignores session-store turn targets for Discord DM sessions", async () => {
    writeStore({
      "agent:main:discord:dm:123456789": {
        sessionId: "sess",
        updatedAt: Date.now(),
        origin: { provider: "discord", to: "123456789", accountId: "main" },
        lastChannel: "discord",
        lastTo: "123456789",
        lastAccountId: "main",
      },
    });

    const adapter = createDiscordNativeApprovalAdapter();
    const target = await adapter.native?.resolveOriginTarget?.({
      cfg: {
        ...NATIVE_DELIVERY_CFG,
        session: { store: STORE_PATH },
      } as never,
      accountId: "main",
      approvalKind: "plugin",
      request: {
        id: "abc",
        request: {
          title: "Plugin approval",
          description: "Let plugin proceed",
          sessionKey: "agent:main:discord:dm:123456789",
          turnSourceChannel: "discord",
          turnSourceTo: "123456789",
          turnSourceAccountId: "main",
        },
        createdAtMs: 1,
        expiresAtMs: 2,
      },
    });

    expect(target).toBeNull();
  });

  it("accepts raw turn-source ids when a Discord channel session backs them", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      cfg: NATIVE_DELIVERY_CFG as never,
      accountId: "main",
      approvalKind: "plugin",
      request: {
        id: "abc",
        request: {
          title: "Plugin approval",
          description: "Let plugin proceed",
          sessionKey: "agent:main:discord:channel:123456789",
          turnSourceChannel: "discord",
          turnSourceTo: "123456789",
          turnSourceAccountId: "main",
        },
        createdAtMs: 1,
        expiresAtMs: 2,
      },
    });

    expect(target).toEqual({ to: "123456789", threadId: undefined });
  });

  it("falls back to extracting the channel id from the session key", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      cfg: NATIVE_DELIVERY_CFG as never,
      accountId: "main",
      approvalKind: "plugin",
      request: {
        id: "abc",
        request: {
          title: "Plugin approval",
          description: "Let plugin proceed",
          sessionKey: "agent:main:discord:channel:987654321",
        },
        createdAtMs: 1,
        expiresAtMs: 2,
      },
    });

    expect(target).toEqual({ to: "987654321", threadId: undefined });
  });

  it("preserves explicit turn-source thread ids on origin targets", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      cfg: NATIVE_DELIVERY_CFG as never,
      accountId: "main",
      approvalKind: "plugin",
      request: {
        id: "abc",
        request: {
          title: "Plugin approval",
          description: "Let plugin proceed",
          sessionKey: "agent:main:discord:channel:123456789:thread:777888999",
          turnSourceChannel: "discord",
          turnSourceTo: "channel:123456789",
          turnSourceThreadId: "777888999",
          turnSourceAccountId: "main",
        },
        createdAtMs: 1,
        expiresAtMs: 2,
      },
    });

    expect(target).toEqual({ to: "123456789", threadId: "777888999" });
  });

  it("falls back to extracting thread ids from the session key", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      cfg: NATIVE_DELIVERY_CFG as never,
      accountId: "main",
      approvalKind: "plugin",
      request: {
        id: "abc",
        request: {
          title: "Plugin approval",
          description: "Let plugin proceed",
          sessionKey: "agent:main:discord:channel:987654321:thread:444555666",
        },
        createdAtMs: 1,
        expiresAtMs: 2,
      },
    });

    expect(target).toEqual({ to: "987654321", threadId: "444555666" });
  });

  it("rejects origin delivery for requests bound to another Discord account", async () => {
    const adapter = createDiscordNativeApprovalAdapter();

    const target = await adapter.native?.resolveOriginTarget?.({
      cfg: NATIVE_APPROVAL_CFG as never,
      accountId: "main",
      approvalKind: "plugin",
      request: {
        id: "abc",
        request: {
          title: "Plugin approval",
          description: "Let plugin proceed",
          turnSourceChannel: "discord",
          turnSourceTo: "channel:123456789",
          turnSourceAccountId: "other",
          sessionKey: "agent:main:missing",
        },
        createdAtMs: 1,
        expiresAtMs: 2,
      },
    });

    expect(target).toBeNull();
  });
});
