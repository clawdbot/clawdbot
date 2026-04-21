import { describe, expect, it, vi } from "vitest";
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

    readChannelAllowFromStoreMock.mockResolvedValue([]);
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

    readChannelAllowFromStoreMock.mockResolvedValue([]);
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
});
