import { describe, expect, it, vi } from "vitest";
import { collectTelegramSecurityAuditFindings } from "../../test/helpers/channels/security-audit-contract.js";
import type { OpenClawConfig } from "../config/config.js";
import { withChannelSecurityStateDir } from "./audit-channel-security.test-helpers.js";

type TelegramAuditParams = Parameters<typeof collectTelegramSecurityAuditFindings>[0];
type ResolvedTelegramAccount = TelegramAuditParams["account"];

const { readChannelAllowFromStoreMock } = vi.hoisted(() => ({
  readChannelAllowFromStoreMock: vi.fn(async () => [] as string[]),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
}));

function createTelegramAccount(
  config: NonNullable<OpenClawConfig["channels"]>["telegram"],
): ResolvedTelegramAccount {
  return {
    accountId: "default",
    enabled: true,
    tokenSource: "config",
    config,
  } as ResolvedTelegramAccount;
}

describe("security audit telegram command findings", () => {
  it("flags Telegram group commands without a sender allowlist", async () => {
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

    await withChannelSecurityStateDir(async () => {
      readChannelAllowFromStoreMock.mockResolvedValue([]);
      const findings = await collectTelegramSecurityAuditFindings({
        cfg: cfg as OpenClawConfig & {
          channels: {
            telegram: NonNullable<OpenClawConfig["channels"]>["telegram"];
          };
        },
        account: createTelegramAccount(cfg.channels!.telegram),
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
  });

  it("warns when Telegram allowFrom entries are non-numeric (legacy @username configs)", async () => {
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

    await withChannelSecurityStateDir(async () => {
      readChannelAllowFromStoreMock.mockResolvedValue([]);
      const findings = await collectTelegramSecurityAuditFindings({
        cfg: cfg as OpenClawConfig & {
          channels: {
            telegram: NonNullable<OpenClawConfig["channels"]>["telegram"];
          };
        },
        account: createTelegramAccount(cfg.channels!.telegram),
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
});
