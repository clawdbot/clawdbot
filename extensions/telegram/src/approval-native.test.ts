import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { clearSessionStoreCacheForTest } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it } from "vitest";
import { telegramApprovalCapability, telegramNativeApprovalAdapter } from "./approval-native.js";

function buildConfig(
  overrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>>,
): OpenClawConfig {
  return {
    channels: {
      telegram: {
        botToken: "tok",
        execApprovals: {
          enabled: true,
          approvers: ["8460800771"],
          target: "dm",
        },
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

const STORE_PATH = path.join(os.tmpdir(), "openclaw-telegram-approval-native-test.json");

function writeStore(store: Record<string, unknown>) {
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  clearSessionStoreCacheForTest();
}

describe("telegram native approval adapter", () => {
  it("describes the correct Telegram exec-approval setup path", () => {
    const text = telegramApprovalCapability.describeExecApprovalSetup?.({
      channel: "telegram",
      channelLabel: "Telegram",
    });

    expect(text).toContain("`channels.telegram.execApprovals.approvers`");
    expect(text).toContain("`commands.ownerAllowFrom`");
    expect(text).not.toContain("`channels.telegram.allowFrom`");
    expect(text).not.toContain("`channels.telegram.defaultTo`");
    expect(text).not.toContain("`channels.telegram.dm.allowFrom`");
  });

  it("describes the named-account Telegram exec-approval setup path", () => {
    const text = telegramApprovalCapability.describeExecApprovalSetup?.({
      channel: "telegram",
      channelLabel: "Telegram",
      accountId: "work",
    });

    expect(text).toContain("`channels.telegram.accounts.work.execApprovals.approvers`");
    expect(text).toContain("`commands.ownerAllowFrom`");
    expect(text).not.toContain("`channels.telegram.accounts.work.allowFrom`");
    expect(text).not.toContain("`channels.telegram.accounts.work.defaultTo`");
    expect(text).not.toContain("`channels.telegram.allowFrom`");
  });

  it("normalizes direct-chat origin targets so DM dedupe can converge", async () => {
    const target = await telegramNativeApprovalAdapter.native?.resolveOriginTarget?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          turnSourceChannel: "telegram",
          turnSourceTo: "telegram:8460800771",
          turnSourceAccountId: "default",
          sessionKey: "agent:main:telegram:direct:8460800771",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "8460800771",
      threadId: undefined,
    });
  });

  it("parses topic-scoped turn-source targets in the extension", async () => {
    const target = await telegramNativeApprovalAdapter.native?.resolveOriginTarget?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-topic-1",
        request: {
          command: "echo hi",
          turnSourceChannel: "telegram",
          turnSourceTo: "telegram:-1003841603622:topic:928",
          turnSourceAccountId: "default",
          sessionKey: "agent:main:telegram:group:-1003841603622:topic:928",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "-1003841603622",
      threadId: 928,
    });
  });

  it("falls back to the session-bound origin target for plugin approvals", async () => {
    writeStore({
      "agent:main:telegram:group:-1003841603622:topic:928": {
        sessionId: "sess",
        updatedAt: Date.now(),
        deliveryContext: {
          channel: "telegram",
          to: "-1003841603622",
          accountId: "default",
          threadId: 928,
        },
      },
    });

    const target = await telegramNativeApprovalAdapter.native?.resolveOriginTarget?.({
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
          sessionKey: "agent:main:telegram:group:-1003841603622:topic:928",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "-1003841603622",
      threadId: 928,
    });
  });

  it("parses numeric string thread ids from the session store for plugin approvals", async () => {
    writeStore({
      "agent:main:telegram:group:-1003841603622:topic:928": {
        sessionId: "sess",
        updatedAt: Date.now(),
        deliveryContext: {
          channel: "telegram",
          to: "-1003841603622",
          accountId: "default",
          threadId: "928",
        },
      },
    });

    const target = await telegramNativeApprovalAdapter.native?.resolveOriginTarget?.({
      cfg: {
        ...buildConfig(),
        session: { store: STORE_PATH },
      },
      accountId: "default",
      approvalKind: "plugin",
      request: {
        id: "plugin:req-2",
        request: {
          title: "Plugin approval",
          description: "Allow access",
          sessionKey: "agent:main:telegram:group:-1003841603622:topic:928",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "-1003841603622",
      threadId: 928,
    });
  });

  it("marks DM-only telegram approvals to notify the origin chat after delivery", () => {
    const capabilities = telegramNativeApprovalAdapter.native?.describeDeliveryCapabilities({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-dm-1",
        request: {
          command: "echo hi",
          turnSourceChannel: "telegram",
          turnSourceTo: "telegram:-1003841603622:topic:928",
          turnSourceAccountId: "default",
          turnSourceThreadId: 928,
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(capabilities).toEqual({
      enabled: true,
      preferredSurface: "approver-dm",
      supportsOriginSurface: true,
      supportsApproverDmSurface: true,
      notifyOriginWhenDmOnly: true,
    });
  });
});
