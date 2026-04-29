import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedTelegramAccount } from "./accounts.js";
import { collectTelegramSecurityAuditFindings } from "./security-audit.js";

const { readChannelAllowFromStoreMock } = vi.hoisted(() => ({
  readChannelAllowFromStoreMock: vi.fn(async () => [] as string[]),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
}));

function createTelegramAccount(
  config: NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>,
): ResolvedTelegramAccount {
  return {
    accountId: "default",
    enabled: true,
    token: "t",
    tokenSource: "config",
    config,
  };
}

function getTelegramConfig(cfg: OpenClawConfig) {
  const config = cfg.channels?.telegram;
  if (!config) {
    throw new Error("expected telegram config");
  }
  return config;
}

describe("Telegram security audit findings", () => {
  beforeEach(() => {
    readChannelAllowFromStoreMock.mockReset();
    readChannelAllowFromStoreMock.mockResolvedValue([]);
  });

  it("flags group commands without a sender allowlist", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          enabled: true,
          botToken: "t",
          groupPolicy: "allowlist",
          groups: { "-100123": {} },
        },
      },
    };

    const findings = await collectTelegramSecurityAuditFindings({
      cfg,
      account: createTelegramAccount(getTelegramConfig(cfg)),
      accountId: "default",
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "channels.telegram.groups.allowFrom.missing",
          severity: "critical",
        }),
      ]),
    );
  });

  it("warns when allowFrom entries are non-numeric legacy @username configs", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          enabled: true,
          botToken: "t",
          groupPolicy: "allowlist",
          groupAllowFrom: ["@TrustedOperator"],
          groups: { "-100123": {} },
        },
      },
    };

    const findings = await collectTelegramSecurityAuditFindings({
      cfg,
      account: createTelegramAccount(getTelegramConfig(cfg)),
      accountId: "default",
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "channels.telegram.allowFrom.invalid_entries",
          severity: "warn",
        }),
      ]),
    );
  });

  it("warns about invalid DM allowFrom entries even when groups are not enabled", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          enabled: true,
          botToken: "t",
          dmPolicy: "allowlist",
          allowFrom: ["@TrustedOperator"],
          groupPolicy: "allowlist",
        },
      },
    };

    const findings = await collectTelegramSecurityAuditFindings({
      cfg,
      account: createTelegramAccount(getTelegramConfig(cfg)),
      accountId: "default",
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "channels.telegram.allowFrom.invalid_entries",
        severity: "warn",
      }),
    ]);
    expect(readChannelAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("warns about invalid DM allowFrom entries when text commands are disabled", async () => {
    const cfg: OpenClawConfig = {
      commands: { text: false },
      channels: {
        telegram: {
          enabled: true,
          botToken: "t",
          dmPolicy: "allowlist",
          allowFrom: ["@TrustedOperator"],
          groupPolicy: "allowlist",
        },
      },
    };

    const findings = await collectTelegramSecurityAuditFindings({
      cfg,
      account: createTelegramAccount(getTelegramConfig(cfg)),
      accountId: "default",
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "channels.telegram.allowFrom.invalid_entries",
        severity: "warn",
      }),
    ]);
    expect(readChannelAllowFromStoreMock).not.toHaveBeenCalled();
  });
});
