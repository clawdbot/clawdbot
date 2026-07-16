import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  OpenClawConfig,
  TelegramAccountConfig,
  TelegramExecApprovalConfig,
} from "openclaw/plugin-sdk/config-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  getTelegramExecApprovalApprovers,
  isTelegramExecApprovalAuthorizedSender,
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalClientEnabled,
  isTelegramExecApprovalTargetRecipient,
  resolveTelegramExecApprovalTarget,
  shouldHandleTelegramExecApprovalRequest,
  shouldEnableTelegramExecApprovalButtons,
  shouldInjectTelegramExecApprovalButtons,
} from "./exec-approvals.js";

const tempDirs: string[] = [];

type TelegramExecApprovalRequest = Parameters<
  typeof shouldHandleTelegramExecApprovalRequest
>[0]["request"];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-exec-approvals-"));
  tempDirs.push(dir);
  return dir;
}

function buildConfig(
  execApprovals?: NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>["execApprovals"],
  channelOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>>,
): OpenClawConfig {
  return {
    channels: {
      telegram: {
        botToken: "tok",
        ...channelOverrides,
        execApprovals,
      },
    },
  } as OpenClawConfig;
}

function telegramAccount(
  accountId: string,
  execApprovals: TelegramExecApprovalConfig,
  overrides: Partial<TelegramAccountConfig> = {},
): TelegramAccountConfig {
  return {
    botToken: `tok-${accountId}`,
    ...overrides,
    execApprovals,
  };
}

function buildMultiAccountTelegramConfig(params: {
  sessionStorePath?: string;
  defaultExecApprovals?: TelegramExecApprovalConfig;
  opsExecApprovals?: TelegramExecApprovalConfig;
  defaultOverrides?: Partial<TelegramAccountConfig>;
  opsOverrides?: Partial<TelegramAccountConfig>;
}): OpenClawConfig {
  return {
    ...(params.sessionStorePath ? { session: { store: params.sessionStorePath } } : {}),
    channels: {
      telegram: {
        accounts: {
          default: telegramAccount(
            "default",
            params.defaultExecApprovals ?? { enabled: true, approvers: ["123"] },
            params.defaultOverrides,
          ),
          ops: telegramAccount(
            "ops",
            params.opsExecApprovals ?? { enabled: true, approvers: ["123"] },
            params.opsOverrides,
          ),
        },
      },
    },
  } as OpenClawConfig;
}

function makeForeignChannelApprovalRequest(params: {
  id: string;
  sessionKey?: string;
}): TelegramExecApprovalRequest {
  return {
    id: params.id,
    request: {
      command: "echo hi",
      sessionKey: params.sessionKey ?? "agent:ops:missing",
      turnSourceChannel: "slack",
      turnSourceTo: "channel:C123",
    },
    createdAtMs: 0,
    expiresAtMs: 1000,
  };
}

describe("telegram exec approvals", () => {
  it("auto-enables when approvers resolve and disables only when forced off", () => {
    expect(isTelegramExecApprovalClientEnabled({ cfg: buildConfig() })).toBe(false);
    expect(
      isTelegramExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: true }),
      }),
    ).toBe(false);
    expect(
      isTelegramExecApprovalClientEnabled({
        cfg: buildConfig(undefined, { allowFrom: ["123"] }),
      }),
    ).toBe(true);
    expect(
      isTelegramExecApprovalClientEnabled({
        cfg: buildConfig({ approvers: ["123"] }),
      }),
    ).toBe(true);
    expect(
      isTelegramExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: false, approvers: ["123"] }),
      }),
    ).toBe(false);
  });

  it("matches approvers by normalized sender id", () => {
    const cfg = buildConfig({ approvers: [123, "456"] });
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "123" })).toBe(true);
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "456" })).toBe(true);
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "789" })).toBe(false);
  });

  it("infers approvers from allowFrom and direct defaultTo", () => {
    const cfg = buildConfig(
      { enabled: true },
      {
        allowFrom: ["12345", "-100999", "@ignored"],
        defaultTo: 67890,
      },
    );

    expect(getTelegramExecApprovalApprovers({ cfg })).toEqual(["12345", "67890"]);
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "12345" })).toBe(true);
    expect(isTelegramExecApprovalApprover({ cfg, senderId: "67890" })).toBe(true);
  });

  it("defaults target to dm", () => {
    expect(
      resolveTelegramExecApprovalTarget({ cfg: buildConfig({ enabled: true, approvers: ["1"] }) }),
    ).toBe("dm");
  });

  it("matches agent filters from the Telegram session key when request.agentId is absent", () => {
    const cfg = buildConfig({
      enabled: true,
      approvers: ["123"],
      agentFilter: ["ops"],
    });

    expect(
      shouldHandleTelegramExecApprovalRequest({
        cfg,
        request: {
          id: "req-1",
          request: {
            command: "echo hi",
            sessionKey: "agent:ops:telegram:direct:123:tail",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toBe(true);
  });

  it("scopes non-telegram turn sources to the stored telegram account", () => {
    const tmpDir = createTempDir();
    const storePath = path.join(tmpDir, "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:ops:telegram:direct:123": {
          sessionId: "main",
          updatedAt: 1,
          origin: {
            provider: "telegram",
            accountId: "ops",
          },
          lastChannel: "slack",
          lastTo: "channel:C999",
          lastAccountId: "work",
        },
      }),
      "utf-8",
    );
    const cfg = buildMultiAccountTelegramConfig({ sessionStorePath: storePath });
    const request = makeForeignChannelApprovalRequest({
      id: "req-2",
      sessionKey: "agent:ops:telegram:direct:123",
    });

    expect(
      shouldHandleTelegramExecApprovalRequest({
        cfg,
        accountId: "default",
        request,
      }),
    ).toBe(false);
    expect(
      shouldHandleTelegramExecApprovalRequest({
        cfg,
        accountId: "ops",
        request,
      }),
    ).toBe(true);
  });

  it("rejects unbound foreign-channel approvals in multi-account telegram configs", () => {
    const cfg = buildMultiAccountTelegramConfig({});
    const request = makeForeignChannelApprovalRequest({ id: "req-3" });

    expect(
      shouldHandleTelegramExecApprovalRequest({
        cfg,
        accountId: "default",
        request,
      }),
    ).toBe(false);
    expect(
      shouldHandleTelegramExecApprovalRequest({
        cfg,
        accountId: "ops",
        request,
      }),
    ).toBe(false);
  });

  it("allows unbound foreign-channel approvals when only one telegram account can handle them", () => {
    const cfg = buildMultiAccountTelegramConfig({
      opsExecApprovals: { enabled: false, approvers: ["123"] },
    });
    const request = makeForeignChannelApprovalRequest({ id: "req-4" });

    expect(
      shouldHandleTelegramExecApprovalRequest({
        cfg,
        accountId: "default",
        request,
      }),
    ).toBe(true);
    expect(
      shouldHandleTelegramExecApprovalRequest({
        cfg,
        accountId: "ops",
        request,
      }),
    ).toBe(false);
  });

  it("uses request filters when checking foreign-channel telegram ambiguity", () => {
    const cfg = buildMultiAccountTelegramConfig({
      defaultExecApprovals: {
        enabled: true,
        approvers: ["123"],
        agentFilter: ["ops"],
      },
      opsExecApprovals: {
        enabled: true,
        approvers: ["123"],
        agentFilter: ["other"],
      },
    });
    const request = makeForeignChannelApprovalRequest({ id: "req-5" });

    expect(
      shouldHandleTelegramExecApprovalRequest({
        cfg,
        accountId: "default",
        request,
      }),
    ).toBe(true);
    expect(
      shouldHandleTelegramExecApprovalRequest({
        cfg,
        accountId: "ops",
        request,
      }),
    ).toBe(false);
  });

  it("ignores disabled telegram accounts when checking foreign-channel ambiguity", () => {
    const cfg = buildMultiAccountTelegramConfig({ opsOverrides: { enabled: false } });
    const request = makeForeignChannelApprovalRequest({ id: "req-6" });

    expect(
      shouldHandleTelegramExecApprovalRequest({
        cfg,
        accountId: "default",
        request,
      }),
    ).toBe(true);
    expect(
      shouldHandleTelegramExecApprovalRequest({
        cfg,
        accountId: "ops",
        request,
      }),
    ).toBe(false);
  });

  it("only injects approval buttons on eligible telegram targets", () => {
    const dmCfg = buildConfig({ enabled: true, approvers: ["123"], target: "dm" });
    const channelCfg = buildConfig({ enabled: true, approvers: ["123"], target: "channel" });
    const bothCfg = buildConfig({ enabled: true, approvers: ["123"], target: "both" });

    expect(shouldInjectTelegramExecApprovalButtons({ cfg: dmCfg, to: "123" })).toBe(true);
    expect(shouldInjectTelegramExecApprovalButtons({ cfg: dmCfg, to: "-100123" })).toBe(false);
    expect(shouldInjectTelegramExecApprovalButtons({ cfg: channelCfg, to: "-100123" })).toBe(true);
    expect(shouldInjectTelegramExecApprovalButtons({ cfg: channelCfg, to: "123" })).toBe(false);
    expect(shouldInjectTelegramExecApprovalButtons({ cfg: bothCfg, to: "123" })).toBe(true);
    expect(shouldInjectTelegramExecApprovalButtons({ cfg: bothCfg, to: "-100123" })).toBe(true);
  });

  it("does not require generic inlineButtons capability to enable exec approval buttons", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "tok",
          capabilities: ["vision"],
          execApprovals: { enabled: true, approvers: ["123"], target: "dm" },
        },
      },
    } as OpenClawConfig;

    expect(shouldEnableTelegramExecApprovalButtons({ cfg, to: "123" })).toBe(true);
  });

  it("still respects explicit inlineButtons off for exec approval buttons", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "tok",
          capabilities: { inlineButtons: "off" },
          execApprovals: { enabled: true, approvers: ["123"], target: "dm" },
        },
      },
    } as OpenClawConfig;

    expect(shouldEnableTelegramExecApprovalButtons({ cfg, to: "123" })).toBe(false);
  });

  describe("isTelegramExecApprovalTargetRecipient", () => {
    function buildTargetConfig(
      targets: Array<{ channel: string; to: string; accountId?: string }>,
    ): OpenClawConfig {
      return {
        channels: { telegram: { botToken: "tok" } },
        approvals: { exec: { enabled: true, mode: "targets", targets } },
      } as OpenClawConfig;
    }

    it("accepts sender who is a DM target", () => {
      const cfg = buildTargetConfig([{ channel: "telegram", to: "12345" }]);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345" })).toBe(true);
    });

    it("rejects sender not in any target", () => {
      const cfg = buildTargetConfig([{ channel: "telegram", to: "12345" }]);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "99999" })).toBe(false);
    });

    it("rejects group targets", () => {
      const cfg = buildTargetConfig([{ channel: "telegram", to: "-100123456" }]);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "123456" })).toBe(false);
    });

    it("ignores non-telegram targets", () => {
      const cfg = buildTargetConfig([{ channel: "discord", to: "12345" }]);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345" })).toBe(false);
    });

    it("returns false when no targets configured", () => {
      const cfg = buildConfig();
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345" })).toBe(false);
    });

    it("returns false when senderId is empty or null", () => {
      const cfg = buildTargetConfig([{ channel: "telegram", to: "12345" }]);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "" })).toBe(false);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: null })).toBe(false);
      expect(isTelegramExecApprovalTargetRecipient({ cfg })).toBe(false);
    });

    it("matches across multiple targets", () => {
      const cfg = buildTargetConfig([
        { channel: "slack", to: "U12345" },
        { channel: "telegram", to: "67890" },
        { channel: "telegram", to: "11111" },
      ]);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "67890" })).toBe(true);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "11111" })).toBe(true);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "U12345" })).toBe(false);
    });

    it("scopes by accountId in multi-bot deployments", () => {
      const cfg = buildTargetConfig([
        { channel: "telegram", to: "12345", accountId: "account-a" },
        { channel: "telegram", to: "67890", accountId: "account-b" },
      ]);
      expect(
        isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345", accountId: "account-a" }),
      ).toBe(true);
      expect(
        isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345", accountId: "account-b" }),
      ).toBe(false);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345" })).toBe(true);
    });

    it("allows unscoped targets regardless of callback accountId", () => {
      const cfg = buildTargetConfig([{ channel: "telegram", to: "12345" }]);
      expect(
        isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345", accountId: "any-account" }),
      ).toBe(true);
    });

    it("requires active target forwarding mode", () => {
      const cfg = {
        channels: { telegram: { botToken: "tok" } },
        approvals: {
          exec: {
            enabled: true,
            mode: "session",
            targets: [{ channel: "telegram", to: "12345" }],
          },
        },
      } as OpenClawConfig;
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345" })).toBe(false);
    });

    it("normalizes prefixed Telegram DM targets", () => {
      const cfg = buildTargetConfig([{ channel: "telegram", to: "tg:12345" }]);
      expect(isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345" })).toBe(true);
    });

    it("normalizes accountId matching", () => {
      const cfg = buildTargetConfig([{ channel: "telegram", to: "12345", accountId: "Work Bot" }]);
      expect(
        isTelegramExecApprovalTargetRecipient({ cfg, senderId: "12345", accountId: "work-bot" }),
      ).toBe(true);
    });
  });

  describe("isTelegramExecApprovalAuthorizedSender", () => {
    it("accepts explicit approvers", () => {
      const cfg = buildConfig({ enabled: true, approvers: ["123"] });
      expect(isTelegramExecApprovalAuthorizedSender({ cfg, senderId: "123" })).toBe(true);
    });

    it("accepts explicit approvers even when the richer client is disabled", () => {
      const cfg = buildConfig({ enabled: false, approvers: ["123"] });
      expect(isTelegramExecApprovalAuthorizedSender({ cfg, senderId: "123" })).toBe(true);
    });

    it("accepts active forwarded DM targets", () => {
      const cfg = {
        channels: { telegram: { botToken: "tok" } },
        approvals: {
          exec: {
            enabled: true,
            mode: "targets",
            targets: [{ channel: "telegram", to: "12345" }],
          },
        },
      } as OpenClawConfig;
      expect(isTelegramExecApprovalAuthorizedSender({ cfg, senderId: "12345" })).toBe(true);
    });
  });
});
